/* ==========================================================================
   Agnayls - firebase-config.js
   Módulo compartilhado: inicialização do Firebase, autenticação Google,
   helpers de Firestore e compactação/conversão de imagens para Base64.
   Incluído (via <script>) em: login.html, cobranca.html, manicures.html,
   agendamentos.html, adm.html e index.html.
   Usa o SDK "compat" do Firebase (funciona com <script> normal, sem
   precisar de bundler/ES modules).
   ========================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCQBtTrb6tWfcEzR-6JQ2Cyob3v26g19oA",
  authDomain: "agnails-47044.firebaseapp.com",
  projectId: "agnails-47044",
  storageBucket: "agnails-47044.firebasestorage.app",
  messagingSenderId: "669802553809",
  appId: "1:669802553809:web:43ae6ea9cd0aa6d05380f0"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

/* ------------------------------------------------------------------------
   [ATUALIZADO v8 - status confirmado no Console] abuso/spam em endpoints
   públicos
   agendamentos.html permite CREATE sem login em "agendamentos",
   "disponibilidade" e "clientes" (por desenho — o cliente final não faz
   login). As regras do Firestore validam o FORMATO dos dados (e, desde a
   v8, também uma janela plausível de datas em "disponibilidade" — ver
   REGRAS_DE_SEGURANCA.txt), mas sozinhas não têm como distinguir um
   navegador real de um script/bot automatizado. Por isso a mitigação de
   bot/spam de fato depende do Firebase App Check.

   Status confirmado no Firebase Console (reconferir após qualquer
   mudança relevante de tráfego):
     1. App "AgNails" registrado com provedor reCAPTCHA — a site key
        abaixo já é a chave real gerada no Console, não é mais um
        placeholder a trocar.
     2. Cloud Firestore: nos últimos 7 dias, ~96% das solicitações
        chegaram com token verificado e 0% caíram em "origem
        desconhecida" ou "solicitações inválidas" — dado suficiente para
        manter o modo "Aplicar" (Enforce) ativado. Se ao conferir o
        Console o Firestore ainda estiver em "Monitorando", mude para
        "Aplicar": Console > App Check > aba APIs > Cloud Firestore.
        Enquanto estiver só "Monitorando", o Firestore aceita requisições
        com ou sem token válido — ou seja, não bloqueia nada de fato.
     3. Authentication (recurso em pré-lançamento): chegou a mostrar uma
        fatia de "origem desconhecida" (tráfego que o próprio Firebase
        descreve como podendo ser forjado, sem o SDK oficial) acima de
        zero. Manter em "Monitorando" até esse número cair de forma
        consistente antes de aplicar Enforce também aqui — aplicar cedo
        demais tem mais risco de bloquear login legítimo do que de
        impedir algo real.

   Importante: mesmo com o Firestore em Enforce, o App Check eleva o
   custo de um ataque automatizado, não o elimina matematicamente, e não
   substitui validação de dados no servidor. Os dois riscos que
   dependiam só de App Check (bloqueio de agenda via "disponibilidade" e
   valor inflado em "agendamentos") já têm mitigação adicional nas regras
   desde a v8; a correção completa de ambos continua exigindo uma Cloud
   Function.

   Por segurança, a ativação abaixo é protegida por try/catch e por uma
   checagem de que o script do App Check foi carregado: se a chave ainda
   não tiver sido configurada, ou o script não estiver incluído numa
   página específica, o app continua funcionando normalmente (só sem
   essa camada extra) em vez de quebrar.
   ------------------------------------------------------------------------ */
const AGNAIL_RECAPTCHA_V3_SITE_KEY = '6LeZynctAAAAAPS8DMMJiqvj7B2ldwuggpQ2qZC3'; // Site key confirmada no Console — não é mais placeholder
try {
  if (typeof firebase.appCheck === 'function' && AGNAIL_RECAPTCHA_V3_SITE_KEY !== 'RECAPTCHA_V3_SITE_KEY') {
    firebase.appCheck().activate(AGNAIL_RECAPTCHA_V3_SITE_KEY, true);
  }
} catch (e) {
  console.warn('App Check não pôde ser ativado (verifique a site key no Firebase Console):', e);
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
// [NOVO] Limite para comprovantes em PDF, medido no resultado já em
// Base64 (mesma unidade que a regra do Firestore usa). Diferente de uma
// imagem, um PDF não pode ser recomprimido via <canvas> — não existe
// equivalente de "reduzir qualidade/dimensões" para esse formato aqui no
// navegador — então, ao contrário de agnailProcessarImagem, um PDF acima
// do limite é simplesmente rejeitado com uma mensagem clara, em vez de
// compactado. O valor fica abaixo dos 950.000 bytes exigidos pela regra
// em pagamentos/{id}.comprovante (ver REGRAS_DE_SEGURANCA.txt), com folga
// de segurança para o overhead de Base64 e o prefixo "data:...;base64,".
const AGNAIL_MAX_PDF_KB = 800;
const AGNAIL_DIAS_RETENCAO_EXCLUSAO = 90;

/* ------------------------------------------------------------------------
   [NOVO] Bloqueio de seleção/cópia de texto
   Aplica-se a todas as páginas que carregam este arquivo (login, cobrança,
   painel da manicure, painel administrativo, agendamento público e a
   página inicial). É apenas uma camada de fricção de interface — não
   substitui nenhum controle de segurança: qualquer pessoa com o DevTools
   do navegador, "Exibir código-fonte" ou uma chamada direta à API do
   Firestore continua acessando os dados normalmente. A segurança real do
   app continua sendo garantida pelas regras do Firestore (ver
   REGRAS_DE_SEGURANCA.txt), que não dependem do que acontece na tela.
   Campos de formulário (input, textarea, select, elementos com
   contenteditable) ficam de fora da restrição, já que precisam de seleção
   nativa para o usuário poder editar o próprio texto digitado, e links
   (<a>) mantêm o menu de contexto para permitir "abrir em nova guia".
   ------------------------------------------------------------------------ */
(function agnailDesativarSelecaoDeTexto() {
  const estilo = document.createElement('style');
  estilo.textContent = `
    * {
      -webkit-user-select: none;
      -moz-user-select: none;
      -ms-user-select: none;
      user-select: none;
    }
    input, textarea, select, [contenteditable="true"] {
      -webkit-user-select: text;
      -moz-user-select: text;
      -ms-user-select: text;
      user-select: text;
    }
  `;
  document.head.appendChild(estilo);

  function permiteSelecao(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('input, textarea, select, [contenteditable="true"]');
  }
  function permiteMenuContexto(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('input, textarea, select, [contenteditable="true"], a');
  }

  ['copy', 'cut', 'selectstart'].forEach((evento) => {
    document.addEventListener(evento, function (e) {
      if (!permiteSelecao(e.target)) e.preventDefault();
    });
  });
  document.addEventListener('contextmenu', function (e) {
    if (!permiteMenuContexto(e.target)) e.preventDefault();
  });
})();

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
 * resultado em Base64 for maior que AGNAIL_MAX_IMG_KB, até aproximar-se de
 * AGNAIL_ALVO_IMG_KB.
 * @param {File} file
 * @returns {Promise<string>} data URL em Base64
 */
async function agnailProcessarImagem(file) {
  if (!file) return '';

  const base64Original = await agnailArquivoParaBase64(file);

  /* [CORRIGIDO - CRÍTICO: comprovantes de ~712KB a 800KB eram rejeitados
     silenciosamente] A checagem antiga comparava file.size (bytes reais
     do arquivo) com AGNAIL_MAX_IMG_KB, mas Base64 tem ~33% de overhead
     sobre o tamanho original — um arquivo de 800KB vira ~1.065KB em
     Base64. Isso fazia arquivos "dentro do limite" (ex.: 750KB) passarem
     direto SEM compactação, gerando uma string maior que os 950.000
     bytes exigidos pela regra do Firestore em pagamentos/{id}.comprovante
     (ver REGRAS_DE_SEGURANCA.txt). O resultado era um permission-denied
     silencioso, específico de fotos nessa faixa de tamanho — intermitente
     e difícil de reproduzir, porque dependia do arquivo escolhido.
     Agora a comparação usa o tamanho REAL em Base64 (a mesma unidade que
     a regra do Firestore mede), então qualquer imagem que ficaria acima
     do limite passa pela compactação abaixo antes de ser enviada. */
  const tamanhoBase64KB = agnailBase64SizeKB(base64Original);
  if (tamanhoBase64KB <= AGNAIL_MAX_IMG_KB) {
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
   [NOVO] Comprovante de pagamento em PDF
   Alguns bancos só disponibilizam o comprovante em PDF (sem opção de
   print/imagem), então o upload de comprovante (cobranca.html) aceita
   tanto imagem quanto PDF. Usa file.type quando disponível e cai para a
   extensão do nome do arquivo como reforço, já que alguns navegadores/SOs
   deixam file.type vazio para certos tipos de arquivo.
   ------------------------------------------------------------------------ */
function agnailArquivoEhPdf(file) {
  if (!file) return false;
  if (file.type === 'application/pdf') return true;
  return /\.pdf$/i.test(file.name || '');
}

/**
 * Processa o arquivo de um comprovante de pagamento, aceitando imagem OU
 * PDF: imagens seguem o fluxo normal de compactação (agnailProcessarImagem);
 * PDFs são apenas convertidos para Base64 e validados contra
 * AGNAIL_MAX_PDF_KB, pois não há como recomprimir um PDF no navegador — se
 * o arquivo for grande demais, a Promise rejeita com uma mensagem
 * amigável (em vez de deixar a rejeição acontecer "seca", só na regra do
 * Firestore, depois de já ter subido tudo).
 * @param {File} file
 * @returns {Promise<string>} data URL em Base64 (image/* ou application/pdf)
 */
async function agnailProcessarComprovante(file) {
  if (!file) return '';

  if (!agnailArquivoEhPdf(file)) {
    return agnailProcessarImagem(file);
  }

  const base64Bruto = await agnailArquivoParaBase64(file);

  // [CORRIGIDO - CRÍTICO: PDF legítimo rejeitado com "Missing or
  // insufficient permissions"] FileReader.readAsDataURL() monta a string
  // como "data:<file.type>;base64,...", usando o MIME que o NAVEGADOR
  // detectou para o arquivo — não necessariamente "application/pdf". Em
  // vários cenários reais (arquivo baixado do app do banco, encaminhado
  // por WhatsApp/e-mail, certas combinações de navegador/SO) file.type
  // vem vazio ou genérico ("application/octet-stream"), mesmo sendo um
  // PDF de verdade. agnailArquivoEhPdf() já tem um fallback pela extensão
  // ".pdf" e reconhece esses casos corretamente, mas a string final
  // continuava dependendo do MIME "adivinhado" pelo navegador — que podia
  // não bater com a regra do Firestore (que exige literalmente o prefixo
  // "data:application/pdf;base64,"), causando permission-denied mesmo com
  // a regra certa publicada. Agora o prefixo é sempre forçado para
  // "application/pdf" quando agnailArquivoEhPdf() já confirmou que é PDF,
  // independente do que o navegador detectou.
  const dadosBase64 = (base64Bruto.split(',')[1] || '');
  const base64 = `data:application/pdf;base64,${dadosBase64}`;

  const tamanhoKB = agnailBase64SizeKB(base64);
  if (tamanhoKB > AGNAIL_MAX_PDF_KB) {
    throw new Error(
      `Este PDF está muito grande (${Math.round(tamanhoKB)}KB). ` +
      `Envie um arquivo de até ${AGNAIL_MAX_PDF_KB}KB, ou tire uma foto/print do comprovante em vez do PDF.`
    );
  }
  return base64;
}

/* ------------------------------------------------------------------------
   Escape de HTML (proteção contra XSS)
   Sempre que um valor puder ter sido digitado por alguém (cliente público
   em agendamentos.html, ou a própria manicure/admin) ele deve passar por
   uma destas funções antes de entrar em um template usado com innerHTML,
   já que nada impede que esses campos cheguem ao Firestore contendo HTML
   ou scripts — seja pela própria UI, seja por uma chamada direta à API.
   ------------------------------------------------------------------------ */

/**
 * Escapa um valor para uso seguro como TEXTO dentro de um template HTML
 * (entre tags, ex: `<span>${agnailEscaparHTML(nome)}</span>`).
 */
function agnailEscaparHTML(valor) {
  const div = document.createElement('div');
  div.textContent = (valor === null || valor === undefined) ? '' : String(valor);
  return div.innerHTML;
}

/**
 * Escapa um valor para uso seguro dentro de um ATRIBUTO HTML delimitado
 * por aspas duplas (ex: `<img src="${agnailEscaparAtributo(url)}">`).
 * Além do escape de HTML, neutraliza aspas para impedir que o valor
 * "escape" do atributo e injete novos atributos/tags.
 */
function agnailEscaparAtributo(valor) {
  return agnailEscaparHTML(valor).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  // meta/perfil: dados PÚBLICOS (lidos sem login pela página de
  // agendamento do cliente). Nunca guardar e-mail/telefone aqui.
  const perfil = {
    nomeEmpresa: '',
    slogan: '',
    imagemPerfil: '',
    perfilCompleto: false,
    criadoEm: agora,
    atualizadoEm: agora
  };

  // meta/perfilPrivado: dados PESSOAIS — leitura restrita à própria dona
  // da conta e ao admin (ver firestore.rules).
  const perfilPrivado = {
    nomeResponsavel: user.displayName || '',
    email: user.email || '',
    telefone: '',
    termosAceitos: false,
    termosAceitosEm: null
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
    // [CORRIGIDO - B3] Antes ficava sempre '' — nunca era populado a
    // partir da conta Google, então o painel administrativo (adm.html)
    // nunca tinha uma foto real para mostrar nas listas de manicures
    // (sempre caía no ícone genérico). user.photoURL já vem pronto do
    // mesmo objeto de usuário do Firebase Auth usado para nome/e-mail
    // acima, sem nenhuma chamada extra.
    foto: user.photoURL || '',
    tipo: 'manicure',
    statusConta: 'ativa',
    criadoEm: agora,
    ultimoLogin: agora
  });

  const manicureRef = agnailManicureRef(user.uid);
  batch.set(manicureRef.collection('meta').doc('perfil'), perfil);
  batch.set(manicureRef.collection('meta').doc('perfilPrivado'), perfilPrivado);
  batch.set(manicureRef.collection('meta').doc('assinatura'), assinatura);
  batch.set(manicureRef.collection('meta').doc('configuracoes'), configuracoes);

  await batch.commit();
  return { perfil, perfilPrivado, assinatura, configuracoes };
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

/**
 * Dados PESSOAIS (e-mail, telefone, nome do responsável, aceite de
 * termos). Só pode ser lido pela própria dona da conta ou por um admin
 * (ver firestore.rules) — nunca chame isto a partir de uma página
 * pública como agendamentos.html.
 */
async function agnailGetPerfilPrivado(uid) {
  const snap = await agnailManicureRef(uid).collection('meta').doc('perfilPrivado').get();
  return snap.exists ? snap.data() : null;
}

/**
 * Retorna o perfil completo (público + privado) mesclado, para uso no
 * painel da própria manicure e no painel administrativo. Se quem chamar
 * não tiver permissão de leitura de meta/perfilPrivado, a parte privada
 * simplesmente vem vazia em vez de derrubar a chamada inteira.
 */
async function agnailGetPerfilCompleto(uid) {
  const [perfil, perfilPrivado] = await Promise.all([
    agnailGetPerfil(uid),
    agnailGetPerfilPrivado(uid).catch(() => null)
  ]);
  return { ...(perfil || {}), ...(perfilPrivado || {}) };
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
    // [CORRIGIDO - B3] Atualiza a partir da conta Google a cada login
    // (mesmo padrão já usado para "nome" logo acima, inclusive cobrindo
    // o caso de a pessoa ter trocado a própria foto no Google depois do
    // cadastro), com fallback pro valor já salvo e, por fim, string
    // vazia.
    foto: user.photoURL || usuarioExistente.foto || ''
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
  // [CORRIGIDO] Contas com mais de 500 documentos numa mesma subcoleção
  // (ex.: agendamentos ou financeiro acumulados ao longo dos anos)
  // faziam essa exclusão falhar: o Firestore rejeita lotes com mais de
  // 500 operações, e o código antigo tentava apagar a subcoleção
  // inteira num único lote. Agora apaga em blocos de até 500 por vez,
  // repetindo busca+exclusão até a subcoleção ficar vazia — funciona
  // independentemente de quantos documentos existirem no total.
  const TAMANHO_MAXIMO_LOTE = 500; // limite de operações por batch no Firestore
  const subcolecoes = ['servicos', 'clientes', 'agendamentos', 'disponibilidade', 'financeiro', 'pagamentos', 'notificacoes', 'meta'];
  for (const nome of subcolecoes) {
    let continuar = true;
    while (continuar) {
      const snap = await agnailManicureRef(uid).collection(nome).limit(TAMANHO_MAXIMO_LOTE).get();
      if (snap.empty) { continuar = false; break; }
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      // Se voltou um bloco cheio (500), provavelmente ainda tem mais —
      // busca de novo (os que acabaram de ser apagados já não vêm mais).
      // Se voltou menos que isso, essa foi a última leva.
      continuar = snap.docs.length === TAMANHO_MAXIMO_LOTE;
    }
  }
  await db.collection('usuarios').doc(uid).delete();
  await db.collection('administracao').doc('contasPendentesExclusao').collection('contas').doc(uid).delete();
}

/**
 * Libera (apaga) os slots de horário reservados por um agendamento na
 * subcoleção pública "disponibilidade", devolvendo o horário para quem
 * quiser reservar. Deve ser chamada sempre que um agendamento for
 * cancelado pela manicure ou pelo admin. Os IDs dos slots ficam
 * salvos no próprio documento do agendamento (campo
 * "slotsDisponibilidade") no momento da criação, então não é preciso
 * recalcular horários/duração aqui.
 * @param {string} uid uid da manicure dona da agenda
 * @param {object} agendamento o objeto do agendamento (precisa ter o
 *   campo slotsDisponibilidade; agendamentos antigos, criados antes desta
 *   funcionalidade, simplesmente não têm nada para liberar)
 */
async function agnailLiberarSlotsAgendamento(uid, agendamento) {
  if (!agendamento || !Array.isArray(agendamento.slotsDisponibilidade) || !agendamento.slotsDisponibilidade.length) {
    return;
  }
  const batch = db.batch();
  agendamento.slotsDisponibilidade.forEach((slotId) => {
    batch.delete(agnailManicureRef(uid).collection('disponibilidade').doc(slotId));
  });
  await batch.commit();
}

/* ------------------------------------------------------------------------
   Pagamentos / cobrança
   ------------------------------------------------------------------------ */
async function agnailEnviarComprovante(uid, file) {
  // [ALTERADO] Aceita imagem OU PDF — alguns bancos só disponibilizam o
  // comprovante em PDF. Ver agnailProcessarComprovante logo acima.
  const base64 = await agnailProcessarComprovante(file);
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

/* ------------------------------------------------------------------------
   [NOVO] Modal de Suporte (e-mail + Instagram)
   Compartilhado entre login.html (mostrado uma vez, logo após o modal de
   boas-vindas do primeiro acesso), manicures.html (botão fixo em
   Configurações) e agendamentos.html (link fixo no rodapé da página
   pública). O elemento é criado sob demanda, na primeira chamada, e
   reaproveitado nas chamadas seguintes — assim não é preciso duplicar o
   HTML do modal em cada página. Como é adicionado como filho direto de
   <body> com a classe "overlay", ele é automaticamente reconhecido pelo
   script de bloqueio de fundo (agnailInicializarBloqueioFundo) já
   presente em manicures.html e agendamentos.html.
   ------------------------------------------------------------------------ */
const AGNAIL_SUPORTE_EMAIL = 'tecminia@gmail.com';
const AGNAIL_SUPORTE_INSTAGRAM_URL = 'https://instagram.com/agnayls';

function agnailAbrirModalSuporte(aoFechar) {
  let overlay = document.getElementById('overlaySuporteAgnail');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'overlaySuporteAgnail';
    overlay.className = 'overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:none;align-items:center;justify-content:center;padding:20px;z-index:500;';
    overlay.innerHTML = `
      <div style="background:var(--card,#fff); border-radius:var(--radius,20px); padding:30px 24px; max-width:380px; width:100%; text-align:center; box-shadow:var(--sombra-lg,0 12px 40px rgba(0,0,0,0.2)); position:relative; font-family:'Nunito',system-ui,sans-serif; color:var(--texto,#5d4a5c);">
        <button id="btnFecharSuporteAgnail" type="button" style="position:absolute; top:12px; right:12px; width:32px; height:32px; border-radius:50%; border:none; background:var(--rosa-claro,#fbeaef); color:var(--rosa-escuro,#c47d8f); cursor:pointer; font-size:1rem; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-xmark"></i></button>
        <div style="font-size:2.2rem; margin-bottom:8px;">💬</div>
        <h2 style="font-family:'Playfair Display',serif; font-size:1.25rem; font-weight:500; margin-bottom:8px;">Precisa de ajuda?</h2>
        <p style="color:var(--texto-claro,#8a7a89); font-size:0.88rem; line-height:1.5; margin-bottom:18px;">Fale com a gente por e-mail para dúvidas e reclamações, ou veja tutoriais de como usar o Agnayls no nosso Instagram.</p>
        <a href="mailto:${AGNAIL_SUPORTE_EMAIL}" style="display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:12px; border-radius:var(--radius-sm,12px); background:var(--rosa-escuro,#c47d8f); color:#fff; text-decoration:none; font-weight:600; font-size:0.9rem; margin-bottom:10px;"><i class="fa-solid fa-envelope"></i> ${AGNAIL_SUPORTE_EMAIL}</a>
        <a href="${AGNAIL_SUPORTE_INSTAGRAM_URL}" target="_blank" rel="noopener" style="display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:12px; border-radius:var(--radius-sm,12px); background:#fff; color:var(--rosa-escuro,#c47d8f); border:2px solid var(--rosa,#e4a5b8); text-decoration:none; font-weight:600; font-size:0.9rem;"><i class="fa-brands fa-instagram"></i> @agnayls no Instagram</a>
      </div>
    `;
    document.body.appendChild(overlay);

    const fechar = function () {
      overlay.style.display = 'none';
      overlay.classList.remove('active', 'show');
      const callback = overlay._agnailAoFechar;
      overlay._agnailAoFechar = null;
      if (typeof callback === 'function') callback();
    };
    overlay.querySelector('#btnFecharSuporteAgnail').addEventListener('click', fechar);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) fechar();
    });
  }
  overlay._agnailAoFechar = aoFechar || null;
  overlay.style.display = 'flex';
  overlay.classList.add('active');
}

/* ------------------------------------------------------------------------
   [NOVO] Paginação real (cursor-based) reutilizável
   Usada em manicures.html (Agendamentos e Financeiro, 20/página) e
   admin-sistema.js (lista de manicures, 50/página). Em vez de carregar a
   coleção inteira e cortar no cliente, cada "página" busca só os
   documentos daquele bloco direto do Firestore, usando .limit()/
   .startAfter() — o que a rules engine do Firestore avalia exatamente
   como qualquer outra leitura (a paginação não muda quem pode ler o quê,
   só quantos documentos vêm de uma vez).

   Navegação é só "anterior/próxima" (sem pular direto pra página N), o
   que é suficiente para as listas do app e evita ter que sustentar um
   cursor por página arbitrária.
   ------------------------------------------------------------------------ */
function agnailCriarPaginador(queryBase, tamanhoPagina) {
  let cursores = [];       // cursores[i] = último documento da página i
  let paginaAtualIndex = -1;
  let ultimaPaginaCheia = true;

  async function buscarPagina(index) {
    let q = queryBase.limit(tamanhoPagina);
    if (index > 0) {
      const cursorAnterior = cursores[index - 1];
      if (!cursorAnterior) return [];
      q = q.startAfter(cursorAnterior);
    }
    const snap = await q.get();
    if (snap.docs.length > 0) {
      cursores[index] = snap.docs[snap.docs.length - 1];
    }
    ultimaPaginaCheia = snap.docs.length === tamanhoPagina;
    paginaAtualIndex = index;
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  return {
    primeira: () => { cursores = []; paginaAtualIndex = -1; return buscarPagina(0); },
    proxima: () => (paginaAtualIndex >= 0 && ultimaPaginaCheia) ? buscarPagina(paginaAtualIndex + 1) : Promise.resolve([]),
    anterior: () => (paginaAtualIndex > 0) ? buscarPagina(paginaAtualIndex - 1) : Promise.resolve([]),
    recarregarAtual: () => (paginaAtualIndex >= 0) ? buscarPagina(paginaAtualIndex) : Promise.resolve([]),
    temProxima: () => paginaAtualIndex >= 0 && ultimaPaginaCheia,
    temAnterior: () => paginaAtualIndex > 0,
    numeroPagina: () => paginaAtualIndex + 1
  };
}

/**
 * Renderiza os botões "‹ Anterior" / "Próxima ›" dentro de um container.
 * Usa estilo inline (com fallback de cor) para funcionar em qualquer
 * página sem depender das variáveis CSS específicas de cada arquivo.
 */
function agnailRenderizarControlesPaginacao(containerId, paginador, callbackAnterior, callbackProxima) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const pagina = paginador.numeroPagina();
  const temAnterior = paginador.temAnterior();
  const temProxima = paginador.temProxima();

  if (pagina <= 1 && !temProxima) {
    container.innerHTML = '';
    return;
  }

  const estiloBase = "padding:8px 16px;border-radius:50px;border:2px solid var(--rosa,#e4a5b8);background:#fff;color:var(--rosa-escuro,#c47d8f);font-family:'Nunito',system-ui,sans-serif;font-weight:600;font-size:0.82rem;cursor:pointer;";
  const estiloDesabilitado = 'opacity:0.4;cursor:not-allowed;';

  container.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:14px 0;';
  container.innerHTML = `
    <button type="button" id="${containerId}_anterior" style="${estiloBase}${temAnterior ? '' : estiloDesabilitado}" ${temAnterior ? '' : 'disabled'}>‹ Anterior</button>
    <span style="font-size:0.82rem;color:var(--texto-claro,#8a7a89);font-weight:600;">Página ${pagina}</span>
    <button type="button" id="${containerId}_proxima" style="${estiloBase}${temProxima ? '' : estiloDesabilitado}" ${temProxima ? '' : 'disabled'}>Próxima ›</button>
  `;
  const btnAnterior = document.getElementById(containerId + '_anterior');
  const btnProxima = document.getElementById(containerId + '_proxima');
  if (btnAnterior && temAnterior) btnAnterior.addEventListener('click', callbackAnterior);
  if (btnProxima && temProxima) btnProxima.addEventListener('click', callbackProxima);
}

/* Exposição global (o app usa scripts clássicos, não ES modules) */
window.Agnayls = {
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
  escaparHTML: agnailEscaparHTML,
  escaparAtributo: agnailEscaparAtributo,
  processarImagem: agnailProcessarImagem,
  processarComprovante: agnailProcessarComprovante,
  getConfigSistema: agnailGetConfigSistema,
  setConfigSistema: agnailSetConfigSistema,
  manicureRef: agnailManicureRef,
  criarEstruturaInicial: agnailCriarEstruturaInicial,
  getUsuario: agnailGetUsuario,
  getAssinatura: agnailGetAssinatura,
  getPerfil: agnailGetPerfil,
  getPerfilPrivado: agnailGetPerfilPrivado,
  getPerfilCompleto: agnailGetPerfilCompleto,
  getConfiguracoes: agnailGetConfiguracoes,
  calcularStatusAcesso: agnailCalcularStatusAcesso,
  processarPosLogin: agnailProcessarPosLogin,
  solicitarExclusaoConta: agnailSolicitarExclusaoConta,
  excluirContaPermanentemente: agnailExcluirContaPermanentemente,
  liberarSlotsAgendamento: agnailLiberarSlotsAgendamento,
  enviarComprovante: agnailEnviarComprovante,
  abrirModalSuporte: agnailAbrirModalSuporte,
  criarPaginador: agnailCriarPaginador,
  renderizarControlesPaginacao: agnailRenderizarControlesPaginacao
};
