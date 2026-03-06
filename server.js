const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const express = require('express');

// ========================================================================
// 1. INICIALIZAÇÃO E CORREÇÃO DE CHAVES
// ========================================================================
let serviceAccount;

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        // O PULO DO GATO: Conserta as quebras de linha da chave privada que o Render bagunça
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }
} catch (error) {
    console.error("❌ ERRO CRÍTICO: O arquivo JSON da chave está mal formatado.");
    process.exit(1); 
}

const appFirebase = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// AQUI ESTÁ O SEGREDO: Conectando no banco de dados EXATO que você criou
const db = getFirestore(appFirebase, "imetametransportebanco");

const estadoAnterior = new Map();

console.log("======================================================");
console.log("🚀 Servidor Imetame INICIADO (Conectado ao Banco Correto)");
console.log("======================================================");

// ========================================================================
// 📡 RADAR INICIAL - VERIFICA SE ESTÁ LENDO O LUGAR CERTO
// ========================================================================
db.collection('requisicoes').get().then(snap => {
    console.log(`📡 [RADAR ATIVO]: O Firebase detectou ${snap.docs.length} requisições no banco 'imetametransportebanco'.`);
}).catch(err => {
    console.log(`❌ Erro no Radar (Verifique o nome do banco ou permissões):`, err);
});

// ========================================================================
// 2. FUNÇÃO DE DISPARO (FCM)
// ========================================================================
async function enviarNotificacao(tipoDestinatario, nomeDestinatario, titulo, mensagem) {
    try {
        let usuariosQuery;

        if (tipoDestinatario === 'Admin') {
            usuariosQuery = await db.collection('usuarios').where('cargo', 'in', ['Admin', 'Dev']).get();
        } else if (tipoDestinatario === 'UsuarioEspecifico' && nomeDestinatario) {
            usuariosQuery = await db.collection('usuarios').where('nome', '==', nomeDestinatario).get();
        }

        if (!usuariosQuery || usuariosQuery.empty) {
            console.log(`   [!] Usuário não encontrado no banco para notificar: ${nomeDestinatario || 'Admins'}`);
            return;
        }

        const tokens = [];
        usuariosQuery.forEach(doc => {
            const user = doc.data();
            if (user.fcmToken) tokens.push(user.fcmToken); 
        });

        console.log(`🔔 DISPARANDO PUSH PARA [${nomeDestinatario || 'Admins'}]: ${titulo}`);

        if (tokens.length > 0) {
            const payload = {
                notification: { title: titulo, body: mensagem },
                tokens: tokens
            };
            const response = await admin.messaging().sendEachForMulticast(payload);
            console.log(`   ✅ SUCESSO! Celulares notificados: ${response.successCount}`);
        } else {
            console.log(`   ⚠️ O usuário foi achado, mas não possui o Token de celular cadastrado no banco.`);
        }
    } catch (error) {
        console.error("   ❌ Erro ao enviar notificação:", error);
    }
}

// ========================================================================
// 3. O VIGIA EM TEMPO REAL
// ========================================================================
db.collection('requisicoes').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
        const id = change.doc.id;
        const dados = change.doc.data();
        const statusAtual = dados.status;
        const seq = String(dados.sequencial || 'NOVA').padStart(4, '0');
        
        const prev = estadoAnterior.get(id) || {};
        const statusAnterior = prev.status;

        if (!statusAnterior && change.type === 'added') {
            estadoAnterior.set(id, { status: statusAtual, sc: dados.sc, oc: dados.oc, nf: dados.nf, nfs: dados.nfs });
            return; 
        }

        if (change.type === 'added' && statusAtual === 'AGUARDANDO_LIDER') {
            enviarNotificacao('UsuarioEspecifico', dados.lider_solicitacao, 'Nova Requisição da Equipe', `Req #${seq} aguardando sua aprovação.`);
        }

        if (statusAnterior === 'AGUARDANDO_LIDER' && statusAtual === 'SOLICITADO') {
            enviarNotificacao('Admin', null, 'Nova Requisição Aprovada', `Req #${seq} aprovada pelo líder.`);
        }

        if (change.type === 'added' && statusAtual === 'SOLICITADO') {
            enviarNotificacao('Admin', null, 'Nova Requisição Recebida', `Req #${seq} criada por ${dados.solicitante}.`);
        }

        if (statusAnterior !== 'AGUARDANDO_OC' && statusAtual === 'AGUARDANDO_OC') {
            enviarNotificacao('UsuarioEspecifico', dados.solicitante, 'SC Gerada!', `SC vinculada à Req #${seq}.`);
        }

        if (statusAnterior !== 'AGUARDANDO_NF' && statusAtual === 'AGUARDANDO_NF') {
            enviarNotificacao('UsuarioEspecifico', dados.solicitante, 'Ordem de Compra Emitida!', `OC anexada na Req #${seq}. Anexe a NF.`);
        }

        const anexouNFNova = dados.nf && !prev.nf;
        const anexouNFSNova = dados.nfs && !prev.nfs;

        if ((statusAnterior !== 'EM_ANALISE_NF' && statusAtual === 'EM_ANALISE_NF') || anexouNFNova || anexouNFSNova) {
            enviarNotificacao('UsuarioEspecifico', dados.solicitante, 'Nota Fiscal Recebida!', `Nova nota anexada na Req #${seq}. Acesse para assinar.`);
        }

        if (statusAnterior === 'EM_ANALISE_NF' && statusAtual === 'CONFERENCIA_NF') {
            enviarNotificacao('Admin', null, 'Notas Assinadas!', `${dados.solicitante} assinou a Req #${seq}.`);
        }

        estadoAnterior.set(id, { status: statusAtual, sc: dados.sc, oc: dados.oc, nf: dados.nf, nfs: dados.nfs });
    });
}, (erro) => {
    console.error("❌ Erro Crítico do Vigia:", erro);
});

// ========================================================================
// 4. TRUQUE DO RENDER PARA MANTER LIGADO
// ========================================================================
const app = express();
app.get('/', (req, res) => res.send('✅ O Servidor de Notificações da Imetame está Online!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor Web rodando na porta ${PORT}.`));