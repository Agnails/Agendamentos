/* ==========================================================================
   Agnail - firebase-config.js
   Módulo compartilhado: inicialização do Firebase, autenticação Google,
   helpers de Firestore e compactação/conversão de imagens para Base64.
   Incluído (via <script>) em: login.html, cobranca.html, manicures.html,
   agendamentos.html, adm.html e index.html.
   Usa o SDK "compat" do Firebase (funciona com <script> normal, sem
   precisar de bundler/ES modules).
   ========================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCuX3SRhDvZS_BiKIL1q_VFwacMBwZ5tbU",
  authDomain: "appagenda-f278b.firebaseapp.com",
  databaseURL: "https://appagenda-f278b-default-rtdb.firebaseio.com",
  projectId: "appagenda-f278b",
  storageBucket: "appagenda-f278b.firebasestorage.app",
  messagingSenderId: "676987896115",
  appId: "1:676987896115:web:74ecdbedabca34f5923e46"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();
const googleProvider = new firebase.auth.GoogleAuthProvider();

/* ------------------------------------------------------------------------
   Constantes
   ------------------------------------------------------------------------ */
const AGNAIL_DIAS_TESTE_PADRAO = 15;
const AGNAIL_MAX_IMG_KB = 800;      // acima disso, compacta
const AGNAIL_ALVO_IMG_KB = 750;     // alvo pós-compactação
const AGNAIL_DIAS_RETENCAO_EXCLUSAO = 90;

/* ------------------------------------------------------------------------
   Autenticação
   ------------------------------------------------------------------------ */
function agnailLoginGoogle() {
  return auth.signInWithPopup(googleProvider);
}

function agnailLogout() {
  return auth.signOut();
}

function agnailOnAuthChange(callback) {
  return auth.onAuthStateChanged(callback);
}

/* ------------------------------------------------------------------------
   Compactação e conversão de imagens para Base64
   Redimensiona/recomprime via <canvas> até ficar abaixo do alvo (ou até
   esgotar as tentativas), sempre devolvendo uma string Base64 (data URL).
   ------------------------------------------------------------------------ */
function agnailArquivoParaBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function agnailBase64SizeKB(base64) {
  // tamanho aproximado em KB a partir do comprimento da string base64
  const semCabecalho = base64.split(',')[1] || base64;
  return (semCabecalho.length * 0.75) / 1024;
}

function agnailCarregarImagem(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Converte um File de imagem em Base64, compactando automaticamente se o
 * arquivo original for maior que AGNAIL_MAX_IMG_KB, até aproximar-se de
 * AGNAIL_ALVO_IMG_KB.
 * @param {File} file
 * @returns {Promise<string>} data URL em Base64
 */
async function agnailProcessarImagem(file) {
  if (!file) return '';
  const tamanhoOriginalKB = file.size / 1024;

  const base64Original = await agnailArquivoParaBase64(file);
  if (tamanhoOriginalKB <= AGNAIL_MAX_IMG_KB) {
    return base64Original;
  }

  // Precisa compactar: redimensiona/reduz qualidade em canvas (JPEG)
  const img = await agnailCarregarImagem(base64Original);
  let largura = img.width;
  let altura = img.height;
  let qualidade = 0.85;
  let resultado = base64Original;

  for (let tentativa = 0; tentativa < 8; tentativa++) {
    const canvas = document.createElement('canvas');
    canvas.width = largura;
    canvas.height = altura;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, largura, altura);
    resultado = canvas.toDataURL('image/jpeg', qualidade);

    const tamanhoAtualKB = agnailBase64SizeKB(resultado);
    if (tamanhoAtualKB <= AGNAIL_ALVO_IMG_KB) break;

    // reduz qualidade primeiro, depois dimensões
    if (qualidade > 0.4) {
      qualidade -= 0.15;
    } else {
      largura = Math.round(largura * 0.8);
      altura = Math.round(altura * 0.8);
    }
  }
  return resultado;
}

/* ------------------------------------------------------------------------
   Utilitários de formulário: máscara de telefone celular e limite de
   caracteres em campos de texto comuns.
   ------------------------------------------------------------------------ */
function agnailMascararCelular(valor) {
  let v = (valor || '').replace(/\D/g, '').slice(0, 11);
  if (v.length > 10) {
    v = v.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
  } else if (v.length > 5) {
    v = v.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
  } else if (v.length > 2) {
    v = v.replace(/(\d{2})(\d{0,5})/, '($1) $2');
  } else if (v.length > 0) {
    v = v.replace(/(\d{0,2})/, '($1');
  }
  return v.trim().replace(/-$/, '').replace(/\)\s*$/, ') ').trimEnd();
}

/**
 * Aplica a máscara de celular em tempo real a um <input>.
 * @param {HTMLInputElement} input
 */
function agnailAplicarMascaraCelular(input) {
  if (!input) return;
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('maxlength', '15');
  input.addEventListener('input', function () {
    const posicaoAntes = input.selectionStart;
    const tamanhoAntes = input.value.length;
    input.value = agnailMascararCelular(input.value);
    const diff = input.value.length - tamanhoAntes;
    const novaPos = Math.max(0, (posicaoAntes || 0) + diff);
    input.setSelectionRange(novaPos, novaPos);
  });
}

/**
 * Limita o comprimento de campos de texto "comuns" (nome, empresa, etc.)
 * a um número máximo de caracteres, aplicando maxlength no elemento.
 * @param {HTMLInputElement|HTMLInputElement[]|string} alvo elemento, lista de elementos, ou seletor CSS
 * @param {number} limite
 */
function agnailLimitarTexto(alvo, limite) {
  limite = limite || 50;
  let elementos = [];
  if (typeof alvo === 'string') {
    elementos = Array.from(document.querySelectorAll(alvo));
  } else if (alvo instanceof NodeList || Array.isArray(alvo)) {
    elementos = Array.from(alvo);
  } else if (alvo) {
    elementos = [alvo];
  }
  elementos.forEach((el) => {
    if (!el || !el.setAttribute) return;
    el.setAttribute('maxlength', String(limite));
  });
}

/* ------------------------------------------------------------------------
   Configurações globais do sistema (administracao/configuracoes)
   ------------------------------------------------------------------------ */
async function agnailGetConfigSistema() {
  const padrao = {
    mensalidade: 50,
    diasTeste: AGNAIL_DIAS_TESTE_PADRAO,
    chavePix: '',
    whatsappFinanceiro: '',
    manutencao: false
  };
  const ref = db.collection('administracao').doc('configuracoes');
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set(padrao);
    return padrao;
  }
  return { ...padrao, ...snap.data() };
}

async function agnailSetConfigSistema(dados) {
  await db.collection('administracao').doc('configuracoes').set(dados, { merge: true });
}

/* ------------------------------------------------------------------------
   Estrutura da manicure (maquiadores/{uid})
   ------------------------------------------------------------------------ */
function agnailManicureRef(uid) {
  return db.collection('maquiadores').doc(uid);
}

/**
 * Cria toda a estrutura inicial de uma manicure no primeiro acesso.
 */
async function agnailCriarEstruturaInicial(user) {
  const configSistema = await agnailGetConfigSistema();
  const agora = firebase.firestore.Timestamp.now();
  const fimTeste = new Date();
  fimTeste.setDate(fimTeste.getDate() + (configSistema.diasTeste || AGNAIL_DIAS_TESTE_PADRAO));

  const perfil = {
    nomeEmpresa: '',
    slogan: '',
    nomeResponsavel: user.displayName || '',
    email: user.email || '',
    telefone: '',
    imagemPerfil: '',
    perfilCompleto: false,
    termosAceitos: false,
    termosAceitosEm: null,
    criadoEm: agora,
    atualizadoEm: agora
  };

  const assinatura = {
    status: 'teste_gratuito',
    plano: 'padrao',
    inicioTeste: agora,
    fimTeste: firebase.firestore.Timestamp.fromDate(fimTeste),
    vencimento: firebase.firestore.Timestamp.fromDate(fimTeste),
    ultimoPagamento: null,
    acessoLiberado: true,
    dataSolicitacaoExclusao: null,
    dataExclusaoPermitida: null
  };

  const configuracoes = {
    nomeEmpresa: '',
    slogan: '',
    whatsapp: '',
    imagem: '',
    horarioInicio: '',
    horarioFim: '',
    intervaloMinutos: 60,
    diasFolga: [],
    folgas: [],
    tema: 'rosa',
    formasPagamento: [],
    servicos: []
  };

  const batch = db.batch();
  const userRef = db.collection('usuarios').doc(user.uid);
  batch.set(userRef, {
    nome: user.displayName || '',
    email: user.email || '',
    foto: '',
    tipo: 'manicure',
    statusConta: 'ativa',
    criadoEm: agora,
    ultimoLogin: agora
  });

  const manicureRef = agnailManicureRef(user.uid);
  batch.set(manicureRef.collection('meta').doc('perfil'), perfil);
  batch.set(manicureRef.collection('meta').doc('assinatura'), assinatura);
  batch.set(manicureRef.collection('meta').doc('configuracoes'), configuracoes);

  await batch.commit();
  return { perfil, assinatura, configuracoes };
}

async function agnailGetUsuario(uid) {
  const snap = await db.collection('usuarios').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function agnailGetAssinatura(uid) {
  const snap = await agnailManicureRef(uid).collection('meta').doc('assinatura').get();
  return snap.exists ? snap.data() : null;
}

async function agnailGetPerfil(uid) {
  const snap = await agnailManicureRef(uid).collection('meta').doc('perfil').get();
  return snap.exists ? snap.data() : null;
}

async function agnailGetConfiguracoes(uid) {
  const snap = await agnailManicureRef(uid).collection('meta').doc('configuracoes').get();
  return snap.exists ? snap.data() : null;
}

/**
 * Calcula o status de acesso da manicure com base na assinatura.
 * Retorna: { status, acessoLiberado, diasRestantesTeste }
 * status ∈ teste_gratuito | aguardando_aprovacao | ativo | expirado | exclusao_solicitada
 */
function agnailCalcularStatusAcesso(assinatura) {
  if (!assinatura) {
    return { status: 'indefinido', acessoLiberado: false, diasRestantesTeste: 0 };
  }
  if (assinatura.dataSolicitacaoExclusao) {
    return { status: 'exclusao_solicitada', acessoLiberado: false, diasRestantesTeste: 0 };
  }

  const agora = new Date();

  if (assinatura.status === 'teste_gratuito') {
    const fimTeste = assinatura.fimTeste ? assinatura.fimTeste.toDate() : null;
    if (fimTeste && agora <= fimTeste) {
      const diasRestantes = Math.max(0, Math.ceil((fimTeste - agora) / 86400000));
      return { status: 'teste_gratuito', acessoLiberado: true, diasRestantesTeste: diasRestantes };
    }
    return { status: 'expirado', acessoLiberado: false, diasRestantesTeste: 0 };
  }

  if (assinatura.status === 'aguardando_aprovacao') {
    return { status: 'aguardando_aprovacao', acessoLiberado: false, diasRestantesTeste: 0 };
  }

  if (assinatura.status === 'ativo') {
    const vencimento = assinatura.vencimento ? assinatura.vencimento.toDate() : null;
    if (vencimento && agora > vencimento) {
      return { status: 'expirado', acessoLiberado: false, diasRestantesTeste: 0 };
    }
    return { status: 'ativo', acessoLiberado: true, diasRestantesTeste: 0 };
  }

  return { status: assinatura.status || 'expirado', acessoLiberado: !!assinatura.acessoLiberado, diasRestantesTeste: 0 };
}

/* ------------------------------------------------------------------------
   Login / primeiro acesso / restauração de conta excluída (soft delete)
   ------------------------------------------------------------------------ */
/**
 * Deve ser chamada logo após o login com Google, em login.html.
 * Cuida de: criar estrutura no primeiro acesso, restaurar conta se havia
 * uma exclusão solicitada, ou apenas atualizar o último login.
 * Retorna { novoUsuario, statusAcesso }
 */
async function agnailProcessarPosLogin(user) {
  const usuarioExistente = await agnailGetUsuario(user.uid);

  if (!usuarioExistente) {
    await agnailCriarEstruturaInicial(user);
    await db.collection('administracao').doc('logs').collection('entradas').add({
      usuario: user.email,
      acao: 'primeiro_cadastro',
      dataHora: firebase.firestore.Timestamp.now(),
      detalhes: 'Estrutura inicial criada'
    });
    const assinatura = await agnailGetAssinatura(user.uid);
    return { novoUsuario: true, statusAcesso: agnailCalcularStatusAcesso(assinatura) };
  }

  // Usuário já existe - atualiza último login
  await db.collection('usuarios').doc(user.uid).set({
    ultimoLogin: firebase.firestore.Timestamp.now(),
    nome: user.displayName || usuarioExistente.nome,
    foto: usuarioExistente.foto || ''
  }, { merge: true });

  // Se havia solicitado exclusão, restaura automaticamente
  if (usuarioExistente.statusConta === 'exclusao_solicitada') {
    await db.collection('usuarios').doc(user.uid).set({ statusConta: 'ativa' }, { merge: true });
    await agnailManicureRef(user.uid).collection('meta').doc('assinatura').set({
      dataSolicitacaoExclusao: null,
      dataExclusaoPermitida: null
    }, { merge: true });
    await db.collection('administracao').doc('contasPendentesExclusao')
      .collection('contas').doc(user.uid).delete().catch(() => {});
    await db.collection('administracao').doc('logs').collection('entradas').add({
      usuario: user.email,
      acao: 'conta_restaurada',
      dataHora: firebase.firestore.Timestamp.now(),
      detalhes: 'Login realizado durante o período de retenção; exclusão cancelada.'
    });
  }

  const assinatura = await agnailGetAssinatura(user.uid);
  return { novoUsuario: false, statusAcesso: agnailCalcularStatusAcesso(assinatura) };
}

/* ------------------------------------------------------------------------
   Exclusão lógica (soft delete) e definitiva
   ------------------------------------------------------------------------ */
async function agnailSolicitarExclusaoConta(uid, emailUsuario) {
  const agora = new Date();
  const dataPermitida = new Date();
  dataPermitida.setDate(dataPermitida.getDate() + AGNAIL_DIAS_RETENCAO_EXCLUSAO);

  await db.collection('usuarios').doc(uid).set({ statusConta: 'exclusao_solicitada' }, { merge: true });
  await agnailManicureRef(uid).collection('meta').doc('assinatura').set({
    dataSolicitacaoExclusao: firebase.firestore.Timestamp.fromDate(agora),
    dataExclusaoPermitida: firebase.firestore.Timestamp.fromDate(dataPermitida)
  }, { merge: true });

  await db.collection('administracao').doc('contasPendentesExclusao')
    .collection('contas').doc(uid).set({
      uid,
      email: emailUsuario,
      dataSolicitacaoExclusao: firebase.firestore.Timestamp.fromDate(agora),
      dataExclusaoPermitida: firebase.firestore.Timestamp.fromDate(dataPermitida)
    });

  await db.collection('administracao').doc('logs').collection('entradas').add({
    usuario: emailUsuario,
    acao: 'exclusao_solicitada',
    dataHora: firebase.firestore.Timestamp.now(),
    detalhes: `Exclusão definitiva liberada em ${dataPermitida.toLocaleDateString('pt-BR')}`
  });
}

/**
 * Remove definitivamente todos os dados de uma manicure. Usado apenas pelo
 * Painel Administrativo (adm.html), após os 90 dias de retenção.
 */
async function agnailExcluirContaPermanentemente(uid) {
  const subcolecoes = ['servicos', 'clientes', 'agendamentos', 'financeiro', 'pagamentos', 'notificacoes', 'meta'];
  for (const nome of subcolecoes) {
    const snap = await agnailManicureRef(uid).collection(nome).get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    if (!snap.empty) await batch.commit();
  }
  await db.collection('usuarios').doc(uid).delete();
  await db.collection('administracao').doc('contasPendentesExclusao').collection('contas').doc(uid).delete();
}

/* ------------------------------------------------------------------------
   Pagamentos / cobrança
   ------------------------------------------------------------------------ */
async function agnailEnviarComprovante(uid, file) {
  const base64 = await agnailProcessarImagem(file);
  const agora = firebase.firestore.Timestamp.now();

  const competencia = new Date().toISOString().slice(0, 7); // YYYY-MM
  const pagamentoRef = agnailManicureRef(uid).collection('pagamentos').doc();
  const configSistema = await agnailGetConfigSistema();

  await pagamentoRef.set({
    competencia,
    valor: configSistema.mensalidade || 50,
    status: 'aguardando_aprovacao',
    comprovante: base64,
    observacoes: '',
    enviadoEm: agora,
    aprovadoEm: null,
    aprovadoPor: null
  });

  await agnailManicureRef(uid).collection('meta').doc('assinatura').set({
    status: 'aguardando_aprovacao'
  }, { merge: true });

  await db.collection('administracao').doc('pagamentosPendentes').collection('itens').doc(pagamentoRef.id).set({
    uid,
    pagamentoId: pagamentoRef.id,
    enviadoEm: agora
  });

  return pagamentoRef.id;
}

/* Exposição global (o app usa scripts clássicos, não ES modules) */
window.Agnail = {
  auth, db,
  firebaseConfig,
  DIAS_TESTE_PADRAO: AGNAIL_DIAS_TESTE_PADRAO,
  DIAS_RETENCAO_EXCLUSAO: AGNAIL_DIAS_RETENCAO_EXCLUSAO,
  loginGoogle: agnailLoginGoogle,
  logout: agnailLogout,
  onAuthChange: agnailOnAuthChange,
  mascararCelular: agnailMascararCelular,
  aplicarMascaraCelular: agnailAplicarMascaraCelular,
  limitarTexto: agnailLimitarTexto,
  processarImagem: agnailProcessarImagem,
  getConfigSistema: agnailGetConfigSistema,
  setConfigSistema: agnailSetConfigSistema,
  manicureRef: agnailManicureRef,
  criarEstruturaInicial: agnailCriarEstruturaInicial,
  getUsuario: agnailGetUsuario,
  getAssinatura: agnailGetAssinatura,
  getPerfil: agnailGetPerfil,
  getConfiguracoes: agnailGetConfiguracoes,
  calcularStatusAcesso: agnailCalcularStatusAcesso,
  processarPosLogin: agnailProcessarPosLogin,
  solicitarExclusaoConta: agnailSolicitarExclusaoConta,
  excluirContaPermanentemente: agnailExcluirContaPermanentemente,
  enviarComprovante: agnailEnviarComprovante
};
