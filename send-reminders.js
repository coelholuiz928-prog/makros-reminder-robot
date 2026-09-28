// =============================================================
// ROBÔ DE LEMBRETE DE REUNIÃO — Makros Command Center
// =============================================================
// O que este script faz, a cada execução:
//   1. Lê as reuniões salvas no Firestore do projeto Makros.
//   2. Lê os "tokens" de notificação push salvos (o "endereço" do
//      celular Android que instalou o app e ativou as notificações).
//   3. Para cada reunião que está entre 5 e 15 minutos de começar
//      (e que ainda não teve lembrete enviado para esse horário),
//      manda uma notificação push pro celular via Firebase Cloud
//      Messaging (FCM) — chega mesmo com o app fechado / celular
//      bloqueado.
//
// Este arquivo roda fora do site (não é hospedado na Netlify). Quem
// dispara ele automaticamente, a cada 5 minutos, é o GitHub Actions
// (arquivo .github/workflows/lembretes.yml neste mesmo repositório).
// É 100% gratuito nas condições normais de uso deste sistema.
// =============================================================

const admin = require('firebase-admin');

// A chave da conta de serviço vem de uma variável de ambiente (Secret
// do GitHub Actions) — nunca deve ser colocada direto neste arquivo
// nem enviada para o repositório.
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) {
  console.error('Faltando a variável de ambiente FIREBASE_SERVICE_ACCOUNT_JSON.');
  process.exit(1);
}

const serviceAccount = JSON.parse(serviceAccountJson);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// Antecedência do aviso, em minutos (ajustado conforme pedido: 15 min antes).
const REMINDER_MINUTES = 15;

// Janela de tolerância: como o robô roda a cada 5 minutos e o GitHub
// Actions não garante o minuto exato (pode atrasar um pouco), disparamos
// o aviso quando a reunião estiver entre estes dois limites de distância
// — assim nenhuma reunião passa direto sem avisar, mesmo com atraso.
const WINDOW_UPPER_MINUTES = REMINDER_MINUTES; // no máximo 15 min antes
const WINDOW_LOWER_MINUTES = 5;                // no mínimo 5 min antes

function parseMeetingDate(meeting) {
  // meeting.data no formato "AAAA-MM-DD", meeting.hora no formato "HH:MM"
  if (!meeting.data || !meeting.hora) return null;
  const [y, mo, d] = meeting.data.split('-').map(Number);
  const [h, mi] = meeting.hora.split(':').map(Number);
  if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) return null;
  return new Date(y, mo - 1, d, h, mi, 0);
}

// "Agora" no fuso horário de Brasília, para bater com as datas/horas
// que o app salva (sempre no fuso local de quem usa o sistema).
function nowInSaoPaulo() {
  const now = new Date();
  const brString = now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
  return new Date(brString);
}

async function main() {
  const now = nowInSaoPaulo();

  const [meetingsSnap, tokensSnap] = await Promise.all([
    db.collection('meetings').get(),
    db.collection('pushTokens').get(),
  ]);

  const tokens = tokensSnap.docs.map((d) => d.id);
  if (!tokens.length) {
    console.log('Nenhum celular com notificação ativada ainda (coleção pushTokens vazia). Nada a fazer.');
    return;
  }

  let enviados = 0;

  for (const docSnap of meetingsSnap.docs) {
    const meeting = docSnap.data();
    if (meeting.done) continue;

    const meetingDate = parseMeetingDate(meeting);
    if (!meetingDate) continue;

    const diffMinutes = (meetingDate.getTime() - now.getTime()) / 60000;
    const reminderKey = `${meeting.data}T${meeting.hora}`; // muda se a reunião for remarcada
    const alreadySent = meeting.pushReminderSentFor === reminderKey;

    const dentroDaJanela = diffMinutes <= WINDOW_UPPER_MINUTES && diffMinutes > WINDOW_LOWER_MINUTES;
    if (alreadySent || !dentroDaJanela) continue;

    const minutosRestantes = Math.max(0, Math.round(diffMinutes));
    const corpo = `${meeting.cliente || 'Cliente'} às ${meeting.hora}${meeting.tipo ? ' · ' + meeting.tipo : ''} — em ${minutosRestantes} min`;

    console.log(`Enviando lembrete: ${corpo}`);

    await Promise.all(
      tokens.map((token) =>
        messaging
          .send({
            token,
            data: {
              title: 'Makros · Lembrete de reunião',
              body: corpo,
            },
          })
          .catch((err) => {
            console.error(`Falha ao enviar para o token ${token.slice(0, 12)}...:`, err.message);
            // Token inválido/expirado (app desinstalado, etc.) — remove pra não tentar de novo.
            if (err.code === 'messaging/registration-token-not-registered') {
              return db.collection('pushTokens').doc(token).delete().catch(() => {});
            }
          })
      )
    );

    await docSnap.ref.update({ pushReminderSentFor: reminderKey });
    enviados++;
  }

  console.log(enviados ? `${enviados} lembrete(s) enviado(s).` : 'Nenhuma reunião dentro da janela de aviso agora.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro no robô de lembretes:', err);
    process.exit(1);
  });
