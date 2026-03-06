const admin = require('firebase-admin');
const express = require('express');

// ========================================================================
// 1. INICIALIZAÇÃO DO FIREBASE ADMIN
// ========================================================================
// Lembre-se de colocar o arquivo serviceAccountKey.json na mesma pasta!
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Memória local para sabermos o estado "anterior" da requisição e não mandar notificação duplicada
const estadoAnterior = new Map();

console.log("🚀 Servidor de Notificações Imetame iniciado com sucesso!");
console.log("👀 Vigiando o banco de dados...");

// ========================================================================
// 2. FUNÇÃO PRINCIPAL DE DISPARO DE NOTIFICAÇÃO PUSH (FCM)
// ========================================================================
async function enviarNotificacao(tipoDestinatario, nomeDestinatario, titulo, mensagem) {
    try {
        let usuariosQuery;

        // Descobre para quem enviar buscando na coleção 'usuarios'
        if (tipoDestinatario === 'Admin') {
            // Se for para Admin, busca todos que são Admin ou Dev
            usuariosQuery = await db.collection('usuarios').where('cargo', 'in', ['Admin', 'Dev']).get();
        } else if (tipoDestinatario === 'UsuarioEspecifico' && nomeDestinatario) {
            // Se for para alguém específico (Solicitante ou Líder), busca pelo nome
            usuariosQuery = await db.collection('usuarios').where('nome', '==', nomeDestinatario).get();
        }

        if (!usuariosQuery || usuariosQuery.empty) {
            console.log(`   [!] Nenhum usuário encontrado para: ${tipoDestinatario} (${nomeDestinatario || 'Geral'})`);
            return;
        }

        // Pega os tokens de notificação (FCM Token) salvos no perfil de cada usuário encontrado
        const tokens = [];
        usuariosQuery.forEach(doc => {
            const user = doc.data();
            if (user.fcmToken) tokens.push(user.fcmToken); 
        });

        console.log(`🔔 PREPARANDO AVISO [${tipoDestinatario === 'Admin' ? 'ADMINISTRADORES' : nomeDestinatario}]: ${titulo} - ${mensagem}`);

        // Se encontrou celulares cadastrados com Token, dispara a notificação
        if (tokens.length > 0) {
            const payload = {
                notification: { 
                    title: titulo, 
                    body: mensagem 
                },
                tokens: tokens
            };
            const response = await admin.messaging().sendMulticast(payload);
            console.log(`   ✅ Sucesso: ${response.successCount} enviadas | Falhas: ${response.failureCount}`);
        } else {
            console.log(`   ⚠️ Usuários encontrados, mas eles ainda não possuem o Token de celular cadastrado no banco de dados.`);
        }
    } catch (error) {
        console.error("   ❌ Erro crítico ao enviar notificação:", error);
    }
}

// ========================================================================
// 3. O VIGIA: ESCUTANDO A COLEÇÃO 'REQUISICOES' EM TEMPO REAL
// ========================================================================
db.collection('requisicoes').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
        const id = change.doc.id;
        const dados = change.doc.data();
        const statusAtual = dados.status;
        const seq = String(dados.sequencial || 'NOVA').padStart(4, '0');
        
        // Pega o estado anterior para comparar o que mudou
        const prev = estadoAnterior.get(id) || {};
        const statusAnterior = prev.status;

        // IGNORA A PRIMEIRA CARGA DO SERVIDOR PARA NÃO FLOODAR NOTIFICAÇÕES VELHAS
        if (!statusAnterior && change.type === 'added') {
            estadoAnterior.set(id, { status: statusAtual, sc: dados.sc, oc: dados.oc, nf: dados.nf, nfs: dados.nfs });
            return; 
        }

        // 🚨 REGRA 1: Encarregado Comum criou -> Notifica o Encarregado Líder
        if (change.type === 'added' && statusAtual === 'AGUARDANDO_LIDER') {
            enviarNotificacao('UsuarioEspecifico', dados.lider_solicitacao, 
                'Nova Requisição da Equipe', 
                `O encarregado ${dados.solicitante} criou a Req #${seq}. Aguardando sua aprovação.`
            );
        }

        // 🚨 REGRA 2: Encarregado Líder aprovou -> Notifica os Administradores
        if (statusAnterior === 'AGUARDANDO_LIDER' && statusAtual === 'SOLICITADO') {
            enviarNotificacao('Admin', null, 
                'Nova Requisição Aprovada', 
                `A Req #${seq} foi aprovada pelo líder e aguarda Geração de SC.`
            );
        }

        // 🚨 REGRA 2.1: Encarregado criou direto (Sem líder) -> Notifica os Administradores
        if (change.type === 'added' && statusAtual === 'SOLICITADO') {
            enviarNotificacao('Admin', null, 
                'Nova Requisição Recebida', 
                `A Req #${seq} foi criada por ${dados.solicitante} e aguarda Geração de SC.`
            );
        }

        // 🚨 REGRA 3: Admin gerou SC -> Notifica o Solicitante
        if (statusAnterior !== 'AGUARDANDO_OC' && statusAtual === 'AGUARDANDO_OC') {
            enviarNotificacao('UsuarioEspecifico', dados.solicitante, 
                'SC Gerada!', 
                `A SC ${dados.sc} foi vinculada à sua Req #${seq}. Aguardando emissão da Ordem de Compra.`
            );
        }

        // 🚨 REGRA 4: Compras/Admin anexou OC -> Notifica o Solicitante
        if (statusAnterior !== 'AGUARDANDO_NF' && statusAtual === 'AGUARDANDO_NF') {
            enviarNotificacao('UsuarioEspecifico', dados.solicitante, 
                'Ordem de Compra Emitida!', 
                `A OC ${dados.oc_numero} foi anexada na Req #${seq}. Por favor, anexe a Nota Fiscal.`
            );
        }

        // 🚨 REGRA 5: Solicitante/Encarregado anexou NF (Danfe) ou NFS -> Notifica Solicitante para Assinar
        // Verifica se o PDF da NF ou NFS apareceu agora
        const anexouNFNova = dados.nf && !prev.nf;
        const anexouNFSNova = dados.nfs && !prev.nfs;

        if ((statusAnterior !== 'EM_ANALISE_NF' && statusAtual === 'EM_ANALISE_NF') || anexouNFNova || anexouNFSNova) {
            let tipoNota = anexouNFSNova ? 'Nota de Serviço' : 'DANFE';
            if (anexouNFNova && anexouNFSNova) tipoNota = 'DANFE e Nota de Serviço';

            enviarNotificacao('UsuarioEspecifico', dados.solicitante, 
                'Nota Fiscal Recebida!', 
                `Uma nova ${tipoNota} foi anexada na Req #${seq}. Acesse o sistema para carimbar e assinar.`
            );
        }

        // 🚨 REGRA 6: Solicitante assinou as notas -> Notifica os Administradores
        if (statusAnterior === 'EM_ANALISE_NF' && statusAtual === 'CONFERENCIA_NF') {
            enviarNotificacao('Admin', null, 
                'Notas Assinadas!', 
                `${dados.solicitante} assinou os documentos da Req #${seq}. Pronta para conferência final.`
            );
        }

        // ATUALIZA A MEMÓRIA PARA O PRÓXIMO CICLO DE MUDANÇAS
        estadoAnterior.set(id, { status: statusAtual, sc: dados.sc, oc: dados.oc, nf: dados.nf, nfs: dados.nfs });
    });
}, (erro) => {
    console.error("❌ Erro Crítico ao escutar o Firebase:", erro);
});


// ========================================================================
// 4. TRUQUE PARA O RENDER NÃO DESLIGAR O SERVIDOR (EXPRESS WEB SERVER)
// ========================================================================
const app = express();

app.get('/', (req, res) => {
    res.send('✅ O Servidor de Notificações Push da Imetame está Online e escutando o Firebase!');
});

// A porta é definida pelo Render através do process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Servidor Web Express rodando na porta ${PORT} (Isso mantém o Render ativo).`);
});