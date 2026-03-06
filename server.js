const admin = require('firebase-admin');

// 1. INICIALIZAÇÃO DO FIREBASE ADMIN
// Você precisa baixar o arquivo JSON de chaves privadas lá no painel do Firebase (Configurações do Projeto > Contas de Serviço)
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Memória local para sabermos o estado "anterior" da requisição e não mandar notificação duplicada
const estadoAnterior = new Map();

console.log("🚀 Servidor de Notificações Imetame iniciado com sucesso!");
console.log("👀 Vigiando o banco de dados...");

// 2. FUNÇÃO PARA ENVIAR A NOTIFICAÇÃO
async function enviarNotificacao(tipoDestinatario, nomeDestinatario, titulo, mensagem) {
    try {
        let usuariosQuery;

        // Descobre para quem enviar buscando na coleção 'usuarios'
        if (tipoDestinatario === 'Admin') {
            usuariosQuery = await db.collection('usuarios').where('cargo', 'in', ['Admin', 'Dev']).get();
        } else if (tipoDestinatario === 'UsuarioEspecifico' && nomeDestinatario) {
            usuariosQuery = await db.collection('usuarios').where('nome', '==', nomeDestinatario).get();
        }

        if (!usuariosQuery || usuariosQuery.empty) {
            console.log(`   [!] Nenhum usuário encontrado para: ${tipoDestinatario} (${nomeDestinatario})`);
            return;
        }

        // Pega os tokens de notificação (FCM Token) salvos no perfil do usuário
        const tokens = [];
        usuariosQuery.forEach(doc => {
            const user = doc.data();
            if (user.fcmToken) tokens.push(user.fcmToken); // fcmToken é o código do celular do usuário
        });

        console.log(`🔔 NOTIFICANDO [${tipoDestinatario === 'Admin' ? 'ADMINISTRADORES' : nomeDestinatario}]: ${titulo} - ${mensagem}`);

        // Se tiver token de celular cadastrado, dispara via Firebase Cloud Messaging
        if (tokens.length > 0) {
            const payload = {
                notification: { title: titulo, body: mensagem },
                tokens: tokens
            };
            const response = await admin.messaging().sendMulticast(payload);
            console.log(`   ✅ Sucesso: ${response.successCount} enviadas | Falhas: ${response.failureCount}`);
        } else {
            console.log(`   ⚠️ Os usuários foram encontrados, mas não possuem Token de celular cadastrado para receber o push.`);
            // AQUI VOCÊ PODE COLOCAR UM DISPARO DE E-MAIL SE PREFERIR (ex: Nodemailer)
        }
    } catch (error) {
        console.error("   ❌ Erro ao enviar notificação:", error);
    }
}

// 3. MONITORAMENTO EM TEMPO REAL DA COLEÇÃO 'REQUISICOES'
db.collection('requisicoes').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
        const id = change.doc.id;
        const dados = change.doc.data();
        const statusAtual = dados.status;
        const seq = String(dados.sequencial || 'NOVA').padStart(4, '0');
        
        // Pega o estado e dados de antes para comparar
        const prev = estadoAnterior.get(id) || {};
        const statusAnterior = prev.status;

        // IGNORA A PRIMEIRA CARGA DO SERVIDOR PARA NÃO FLOODAR NOTIFICAÇÕES VELHAS
        if (!statusAnterior && change.type === 'added') {
            estadoAnterior.set(id, { status: statusAtual, sc: dados.sc, oc: dados.oc, nf: dados.nf, nfs: dados.nfs });
            return; 
        }

        // ========================================================================
        // 🚨 REGRA 1: Encarregado Comum criou -> Notifica o Encarregado Líder
        // ========================================================================
        if (change.type === 'added' && statusAtual === 'AGUARDANDO_LIDER') {
            enviarNotificacao('UsuarioEspecifico', dados.lider_solicitacao, 
                'Nova Requisição da Equipe', 
                `O encarregado ${dados.solicitante} criou a Req #${seq}. Aguardando sua aprovação.`
            );
        }

        // ========================================================================
        // 🚨 REGRA 2: Encarregado Líder aprovou -> Notifica o Administrador
        // ========================================================================
        if (statusAnterior === 'AGUARDANDO_LIDER' && statusAtual === 'SOLICITADO') {
            enviarNotificacao('Admin', null, 
                'Nova Requisição Aprovada', 
                `A Req #${seq} foi aprovada pelo líder e aguarda Geração de SC.`
            );
        }

        // (Extra) Se o encarregado comum não tiver líder, ele vai direto para SOLICITADO
        if (change.type === 'added' && statusAtual === 'SOLICITADO') {
            enviarNotificacao('Admin', null, 
                'Nova Requisição', 
                `A Req #${seq} foi criada por ${dados.solicitante} e aguarda Geração de SC.`
            );
        }

        // ========================================================================
        // 🚨 REGRA 3: Admin gerou SC -> Notifica o Solicitante
        // ========================================================================
        if (statusAnterior !== 'AGUARDANDO_OC' && statusAtual === 'AGUARDANDO_OC') {
            enviarNotificacao('UsuarioEspecifico', dados.solicitante, 
                'SC Gerada!', 
                `A SC ${dados.sc} foi vinculada à sua Req #${seq}. Aguardando emissão da Ordem de Compra.`
            );
        }

        // ========================================================================
        // 🚨 REGRA 4: Admin (ou Compras) anexou OC -> Notifica o Solicitante
        // ========================================================================
        if (statusAnterior !== 'AGUARDANDO_NF' && statusAtual === 'AGUARDANDO_NF') {
            enviarNotificacao('UsuarioEspecifico', dados.solicitante, 
                'Ordem de Compra Emitida!', 
                `A OC ${dados.oc_numero} foi anexada na Req #${seq}. Por favor, anexe a Nota Fiscal.`
            );
        }

        // ========================================================================
        // 🚨 REGRA 5: Anexou NF (Danfe) ou NFS -> Notifica Solicitante para Assinar
        // ========================================================================
        // Compara se o status mudou para EM_ANALISE_NF, ou se anexou uma nota nova enquanto já estava lá
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

        // ========================================================================
        // 🚨 REGRA 6: Solicitante assinou as notas -> Notifica o Admin
        // ========================================================================
        if (statusAnterior === 'EM_ANALISE_NF' && statusAtual === 'CONFERENCIA_NF') {
            enviarNotificacao('Admin', null, 
                'Notas Assinadas!', 
                `${dados.solicitante} assinou os documentos da Req #${seq}. Pronta para conferência final.`
            );
        }

        // ATUALIZA A MEMÓRIA PARA O PRÓXIMO CICLO
        estadoAnterior.set(id, { status: statusAtual, sc: dados.sc, oc: dados.oc, nf: dados.nf, nfs: dados.nfs });
    });
}, (erro) => {
    console.error("❌ Erro ao escutar o Firebase:", erro);
});