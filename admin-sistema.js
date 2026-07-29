/* ==========================================================================
   Agnail - admin-sistema.js
   Lógica do Painel Administrativo do sistema (super-admin), separado do
   painel de cada manicure (manicures.html).

   Sobre o acesso de administrador:
   - O campo usuarios/{uid}.tipo precisa ser "admin" para liberar este painel.
   - Por segurança, não existe nenhum caminho no app (nem nas regras do
     Firestore) que permita a um usuário se autopromover a admin. O primeiro
     administrador deve ser definido manualmente no Firebase Console:
     Firestore Database > coleção "usuarios" > documento do usuário (faça
     login uma vez normalmente para o documento ser criado) > altere o
     campo "tipo" de "manicure" para "admin". Veja SETUP.md.
   ========================================================================== */
(function () {
    let adminAtual = null;
    let configSistemaCache = null;
    let manicuresCache = [];

    function mostrarToast(msg, tipo) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.className = 'toast ' + (tipo || '');
        void t.offsetWidth;
        t.classList.add('show');
        clearTimeout(t._timeout);
        t._timeout = setTimeout(() => t.classList.remove('show'), 3000);
    }

    function formatarData(timestamp) {
        if (!timestamp) return '-';
        const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        return d.toLocaleDateString('pt-BR');
    }

    function badgeStatus(status) {
        const mapa = {
            teste_gratuito: ['badge-teste', 'Teste Grátis'],
            aguardando_aprovacao: ['badge-aguardando', 'Aguardando Aprovação'],
            ativo: ['badge-ativo', 'Plano Ativo'],
            expirado: ['badge-expirado', 'Plano Expirado'],
            exclusao_solicitada: ['badge-exclusao', 'Conta em Exclusão']
        };
        const [classe, texto] = mapa[status] || ['badge-expirado', status];
        return `<span class="badge ${classe}">${texto}</span>`;
    }

    /* ---------------- LOGIN / VERIFICAÇÃO DE ADMIN ----------------
       Por segurança, não é possível se autopromover a administrador pelo
       navegador (isso seria uma falha grave de segurança). O campo
       usuarios/{uid}.tipo só pode ser "admin" se for definido manualmente
       no Firebase Console (Firestore Database > coleção "usuarios" >
       documento do usuário > campo "tipo" = "admin"). Veja o arquivo
       SETUP.md para o passo a passo. */
    async function verificarAdmin(user) {
        const usuarioDoc = await Agnail.db.collection('usuarios').doc(user.uid).get();
        return usuarioDoc.exists && usuarioDoc.data().tipo === 'admin';
    }

    document.getElementById('btnLoginAdmin').addEventListener('click', async function () {
        try {
            const cred = await Agnail.loginGoogle();
            const autorizado = await verificarAdmin(cred.user);
            if (!autorizado) {
                document.getElementById('avisoNegado').classList.add('show');
                await Agnail.logout();
                return;
            }
            iniciarPainel(cred.user);
        } catch (e) {
            console.error(e);
            mostrarToast('Erro ao entrar.', 'erro');
        }
    });

    document.getElementById('btnSairAdmin').addEventListener('click', async function () {
        await Agnail.logout();
        window.location.reload();
    });

    Agnail.onAuthChange(async function (user) {
        if (!user) return;
        const usuarioDoc = await Agnail.db.collection('usuarios').doc(user.uid).get();
        if (usuarioDoc.exists && usuarioDoc.data().tipo === 'admin') {
            iniciarPainel(user);
        }
    });

    /* ---------------- INICIALIZAÇÃO DO PAINEL ---------------- */
    async function iniciarPainel(user) {
        adminAtual = user;
        document.getElementById('telaLogin').classList.add('escondido');
        document.getElementById('telaPrincipal').classList.remove('escondido');
        document.getElementById('tabsBottomAdmin').classList.remove('escondido');
        document.getElementById('emailAdminLogado').textContent = user.email;

        configSistemaCache = await Agnail.getConfigSistema();
        preencherFormConfig();

        await Promise.all([carregarManicures(), carregarPagamentosPendentes(), carregarContasExclusao()]);
    }

    /* ---------------- ABAS ---------------- */
    document.querySelectorAll('.tab-btn-bottom').forEach(btn => {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.tab-btn-bottom').forEach(b => b.classList.remove('ativo'));
            document.querySelectorAll('.aba').forEach(a => a.classList.remove('ativa'));
            this.classList.add('ativo');
            document.getElementById('aba-' + this.dataset.aba).classList.add('ativa');
        });
    });

    /* ---------------- ATUALIZAR DADOS ---------------- */
    document.getElementById('btnAtualizarDados').addEventListener('click', async function () {
        const btn = this;
        const iconeOriginal = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Atualizando...';
        try {
            configSistemaCache = await Agnail.getConfigSistema();
            preencherFormConfig();
            await Promise.all([carregarManicures(), carregarPagamentosPendentes(), carregarContasExclusao()]);
            mostrarToast('Dados atualizados!', 'sucesso');
        } catch (e) {
            console.error(e);
            mostrarToast('Erro ao atualizar dados.', 'erro');
        } finally {
            btn.disabled = false;
            btn.innerHTML = iconeOriginal;
        }
    });

    /* ---------------- DASHBOARD: LISTA DE MANICURES ---------------- */
    async function carregarManicures() {
        const usuariosSnap = await Agnail.db.collection('usuarios').where('tipo', '==', 'manicure').get();
        const lista = [];

        for (const doc of usuariosSnap.docs) {
            const uid = doc.id;
            const usuario = doc.data();
            const [perfil, assinatura] = await Promise.all([
                Agnail.getPerfil(uid),
                Agnail.getAssinatura(uid)
            ]);
            const statusAcesso = Agnail.calcularStatusAcesso(assinatura);
            lista.push({ uid, usuario, perfil, assinatura, statusAcesso });
        }
        manicuresCache = lista;
        renderizarStats(lista);
        renderizarListaManicures(lista);
    }

    function renderizarStats(lista) {
        const total = lista.length;
        const ativos = lista.filter(m => m.statusAcesso.status === 'ativo').length;
        const teste = lista.filter(m => m.statusAcesso.status === 'teste_gratuito').length;
        const pendentes = lista.filter(m => m.statusAcesso.status === 'aguardando_aprovacao').length;
        const expirados = lista.filter(m => m.statusAcesso.status === 'expirado').length;

        document.getElementById('statsGrid').innerHTML = `
            <div class="stat-card"><div class="num">${total}</div><div class="lbl">Manicures cadastradas</div></div>
            <div class="stat-card"><div class="num">${ativos}</div><div class="lbl">Planos ativos</div></div>
            <div class="stat-card"><div class="num">${teste}</div><div class="lbl">Em teste grátis</div></div>
            <div class="stat-card"><div class="num">${pendentes}</div><div class="lbl">Aguardando aprovação</div></div>
            <div class="stat-card"><div class="num">${expirados}</div><div class="lbl">Expirados</div></div>
        `;
    }

    function renderizarListaManicures(lista) {
        const container = document.getElementById('listaManicures');
        if (lista.length === 0) {
            container.innerHTML = '<div class="vazio">Nenhuma manicure cadastrada ainda.</div>';
            return;
        }
        container.innerHTML = lista.map(m => {
            const nome = m.perfil?.nomeEmpresa || m.usuario.nome || 'Sem nome';
            const foto = m.usuario.foto
                ? `<img src="${m.usuario.foto}" alt="">`
                : `<i class="fa-solid fa-user"></i>`;
            const venc = m.assinatura?.vencimento ? formatarData(m.assinatura.vencimento) : '-';
            const ultimoPag = m.assinatura?.ultimoPagamento ? formatarData(m.assinatura.ultimoPagamento) : '-';
            const diasTeste = m.statusAcesso.status === 'teste_gratuito' ? `${m.statusAcesso.diasRestantesTeste}d` : '-';
            return `
            <div class="manicure-card">
                <div class="manicure-foto">${foto}</div>
                <div class="manicure-info">
                    <div class="nome">${nome}</div>
                    <div class="email">${m.usuario.email || ''}</div>
                </div>
                <div class="manicure-meta">
                    <span>Cadastro: <strong>${formatarData(m.usuario.criadoEm)}</strong></span>
                    <span>Teste restante: <strong>${diasTeste}</strong></span>
                    <span>Vencimento: <strong>${venc}</strong></span>
                    <span>Último pgto: <strong>${ultimoPag}</strong></span>
                </div>
                ${badgeStatus(m.statusAcesso.status)}
                <button class="btn-detalhe" onclick="AgnailAdmin.abrirDetalhe('${m.uid}')">Detalhes</button>
            </div>`;
        }).join('');
    }

    /* ---------------- MODAL DE DETALHE + GESTÃO ---------------- */
    window.AgnailAdmin = window.AgnailAdmin || {};

    window.AgnailAdmin.abrirDetalhe = function (uid) {
        const m = manicuresCache.find(x => x.uid === uid);
        if (!m) return;
        const nome = m.perfil?.nomeEmpresa || m.usuario.nome || 'Sem nome';

        document.getElementById('conteudoDetalheManicure').innerHTML = `
            <div class="linha"><span class="lbl">Nome</span><span>${nome}</span></div>
            <div class="linha"><span class="lbl">Responsável</span><span>${m.perfil?.nomeResponsavel || '-'}</span></div>
            <div class="linha"><span class="lbl">E-mail</span><span>${m.usuario.email || '-'}</span></div>
            <div class="linha"><span class="lbl">Status</span><span>${badgeStatus(m.statusAcesso.status)}</span></div>
            <div class="linha"><span class="lbl">Cadastro</span><span>${formatarData(m.usuario.criadoEm)}</span></div>
            <div class="linha"><span class="lbl">Último acesso</span><span>${formatarData(m.usuario.ultimoLogin)}</span></div>
            <div class="linha"><span class="lbl">Vencimento</span><span>${formatarData(m.assinatura?.vencimento)}</span></div>
            <div class="linha"><span class="lbl">Acesso liberado</span><span>${m.assinatura?.acessoLiberado ? 'Sim' : 'Não'}</span></div>
            <div class="campo" style="margin-top:12px;">
                <label style="font-size:0.8rem; font-weight:600;">Alterar vencimento</label>
                <input type="date" id="inputNovoVencimento" style="width:100%; padding:9px; border-radius:8px; border:1px solid #e0d5da; margin-top:4px;">
            </div>
            <div class="acoes-modal">
                <button class="btn-venc" onclick="AgnailAdmin.salvarVencimento('${uid}')">Salvar vencimento</button>
                ${m.assinatura?.acessoLiberado
                    ? `<button class="btn-bloquear" onclick="AgnailAdmin.bloquearAcesso('${uid}')">Bloquear acesso</button>`
                    : `<button class="btn-liberar" onclick="AgnailAdmin.liberarAcesso('${uid}')">Liberar acesso</button>`}
            </div>
        `;
        document.getElementById('overlayDetalheManicure').classList.add('show');
    };

    document.getElementById('fecharDetalheManicure').addEventListener('click', () =>
        document.getElementById('overlayDetalheManicure').classList.remove('show'));

    window.AgnailAdmin.salvarVencimento = async function (uid) {
        const valor = document.getElementById('inputNovoVencimento').value;
        if (!valor) { mostrarToast('Escolha uma data.', 'erro'); return; }
        const data = new Date(valor + 'T23:59:59');
        await Agnail.manicureRef(uid).collection('meta').doc('assinatura').set({
            vencimento: firebase.firestore.Timestamp.fromDate(data),
            status: 'ativo',
            acessoLiberado: true
        }, { merge: true });
        mostrarToast('Vencimento atualizado!', 'sucesso');
        document.getElementById('overlayDetalheManicure').classList.remove('show');
        carregarManicures();
    };

    window.AgnailAdmin.bloquearAcesso = async function (uid) {
        await Agnail.manicureRef(uid).collection('meta').doc('assinatura').set({
            acessoLiberado: false, status: 'expirado'
        }, { merge: true });
        mostrarToast('Acesso bloqueado.', 'sucesso');
        document.getElementById('overlayDetalheManicure').classList.remove('show');
        carregarManicures();
    };

    window.AgnailAdmin.liberarAcesso = async function (uid) {
        await Agnail.manicureRef(uid).collection('meta').doc('assinatura').set({
            acessoLiberado: true, status: 'ativo'
        }, { merge: true });
        mostrarToast('Acesso liberado.', 'sucesso');
        document.getElementById('overlayDetalheManicure').classList.remove('show');
        carregarManicures();
    };

    /* ---------------- PAGAMENTOS PENDENTES ---------------- */
    async function carregarPagamentosPendentes() {
        const pendentesSnap = await Agnail.db.collection('administracao').doc('pagamentosPendentes').collection('itens').get();
        const container = document.getElementById('listaPagamentos');

        if (pendentesSnap.empty) {
            container.innerHTML = '<div class="vazio">Nenhum pagamento aguardando aprovação.</div>';
            return;
        }

        const cartoes = [];
        for (const item of pendentesSnap.docs) {
            const { uid, pagamentoId } = item.data();
            const pagamentoSnap = await Agnail.manicureRef(uid).collection('pagamentos').doc(pagamentoId).get();
            if (!pagamentoSnap.exists) continue;
            const pagamento = pagamentoSnap.data();
            if (pagamento.status !== 'aguardando_aprovacao') continue;

            const perfil = await Agnail.getPerfil(uid);
            const nome = perfil?.nomeEmpresa || uid;

            cartoes.push(`
                <div class="pagamento-card">
                    <div class="pagamento-topo">
                        <span class="nome">${nome}</span>
                        <span class="valor">R$ ${Number(pagamento.valor || 0).toFixed(2).replace('.', ',')}</span>
                    </div>
                    <div style="font-size:0.8rem; color:var(--texto-claro);">Competência: ${pagamento.competencia} • Enviado em ${formatarData(pagamento.enviadoEm)}</div>
                    <img class="comprovante-img" src="${pagamento.comprovante}" onclick="AgnailAdmin.ampliarComprovante('${pagamento.comprovante}')">
                    <textarea class="obs" id="obs-${pagamentoId}" placeholder="Observações (opcional)"></textarea>
                    <div class="acoes-pagamento">
                        <button class="btn-aprovar" onclick="AgnailAdmin.aprovarPagamento('${uid}','${pagamentoId}')">Aprovar</button>
                        <button class="btn-rejeitar" onclick="AgnailAdmin.rejeitarPagamento('${uid}','${pagamentoId}')">Rejeitar</button>
                    </div>
                </div>
            `);
        }
        container.innerHTML = cartoes.length ? cartoes.join('') : '<div class="vazio">Nenhum pagamento aguardando aprovação.</div>';
    }

    window.AgnailAdmin.ampliarComprovante = function (src) {
        document.getElementById('imgComprovanteAmpliado').src = src;
        document.getElementById('overlayComprovanteAmpliado').classList.add('show');
    };
    document.getElementById('fecharComprovanteAmpliado').addEventListener('click', () =>
        document.getElementById('overlayComprovanteAmpliado').classList.remove('show'));

    window.AgnailAdmin.aprovarPagamento = async function (uid, pagamentoId) {
        const obs = document.getElementById('obs-' + pagamentoId)?.value || '';
        const agora = firebase.firestore.Timestamp.now();

        // A validade sempre soma 30 dias por mensalidade. Se a assinatura
        // atual ainda não venceu, os 30 dias somam a partir do vencimento
        // atual (para não "perder" dias já pagos); caso já tenha expirado,
        // conta a partir de hoje.
        const assinaturaAtual = manicuresCache.find(m => m.uid === uid)?.assinatura;
        const vencimentoAtual = assinaturaAtual?.vencimento ? assinaturaAtual.vencimento.toDate() : null;
        const baseData = (vencimentoAtual && vencimentoAtual.getTime() > Date.now()) ? vencimentoAtual : new Date();
        const novoVencimento = new Date(baseData);
        novoVencimento.setDate(novoVencimento.getDate() + 30);

        await Agnail.manicureRef(uid).collection('pagamentos').doc(pagamentoId).set({
            status: 'aprovado', observacoes: obs, aprovadoEm: agora, aprovadoPor: adminAtual.email
        }, { merge: true });

        await Agnail.manicureRef(uid).collection('meta').doc('assinatura').set({
            status: 'ativo', acessoLiberado: true, ultimoPagamento: agora,
            vencimento: firebase.firestore.Timestamp.fromDate(novoVencimento)
        }, { merge: true });

        await Agnail.db.collection('administracao').doc('pagamentosPendentes').collection('itens').doc(pagamentoId).delete();

        mostrarToast('Pagamento aprovado!', 'sucesso');
        carregarPagamentosPendentes();
        carregarManicures();
    };

    window.AgnailAdmin.rejeitarPagamento = async function (uid, pagamentoId) {
        const obs = document.getElementById('obs-' + pagamentoId)?.value || '';
        await Agnail.manicureRef(uid).collection('pagamentos').doc(pagamentoId).set({
            status: 'rejeitado', observacoes: obs
        }, { merge: true });
        await Agnail.manicureRef(uid).collection('meta').doc('assinatura').set({
            status: 'expirado', acessoLiberado: false
        }, { merge: true });
        await Agnail.db.collection('administracao').doc('pagamentosPendentes').collection('itens').doc(pagamentoId).delete();

        mostrarToast('Pagamento rejeitado.', 'sucesso');
        carregarPagamentosPendentes();
        carregarManicures();
    };

    /* ---------------- CONTAS PENDENTES DE EXCLUSÃO ---------------- */
    async function carregarContasExclusao() {
        const snap = await Agnail.db.collection('administracao').doc('contasPendentesExclusao').collection('contas').get();
        const container = document.getElementById('listaExclusoes');

        if (snap.empty) {
            container.innerHTML = '<div class="vazio">Nenhuma conta pendente de exclusão.</div>';
            return;
        }

        const cartoes = [];
        for (const doc of snap.docs) {
            const dados = doc.data();
            const uid = doc.id;
            const usuario = await Agnail.getUsuario(uid);
            if (!usuario) continue;
            const diasDecorridos = Math.floor((Date.now() - dados.dataSolicitacaoExclusao.toDate()) / 86400000);
            const disponivelHoje = Date.now() >= dados.dataExclusaoPermitida.toDate().getTime();

            cartoes.push(`
                <div class="exclusao-card">
                    <div class="manicure-foto">${usuario.foto ? `<img src="${usuario.foto}">` : '<i class="fa-solid fa-user"></i>'}</div>
                    <div class="manicure-info">
                        <div class="nome">${usuario.nome || '-'}</div>
                        <div class="email">${usuario.email || '-'}</div>
                    </div>
                    <div class="manicure-meta">
                        <span>Solicitado em: <strong>${formatarData(dados.dataSolicitacaoExclusao)}</strong></span>
                        <span>Exclusão liberada em: <strong>${formatarData(dados.dataExclusaoPermitida)}</strong></span>
                        <span>Dias decorridos: <strong>${diasDecorridos}</strong></span>
                    </div>
                    <button class="btn-reativar" onclick="AgnailAdmin.reativarConta('${uid}')">Reativar Conta</button>
                    <button class="btn-excluir-perm" ${disponivelHoje ? '' : 'disabled title="Ainda dentro do período de retenção de 90 dias"'} onclick="AgnailAdmin.excluirPermanente('${uid}')">Excluir Permanentemente</button>
                </div>
            `);
        }
        container.innerHTML = cartoes.join('');
    }

    window.AgnailAdmin.reativarConta = async function (uid) {
        await Agnail.db.collection('usuarios').doc(uid).set({ statusConta: 'ativa' }, { merge: true });
        await Agnail.manicureRef(uid).collection('meta').doc('assinatura').set({
            dataSolicitacaoExclusao: null, dataExclusaoPermitida: null
        }, { merge: true });
        await Agnail.db.collection('administracao').doc('contasPendentesExclusao').collection('contas').doc(uid).delete();
        mostrarToast('Conta reativada!', 'sucesso');
        carregarContasExclusao();
        carregarManicures();
    };

    window.AgnailAdmin.excluirPermanente = async function (uid) {
        if (!confirm('Esta ação é irreversível e removerá todos os dados desta manicure. Continuar?')) return;
        await Agnail.excluirContaPermanentemente(uid);
        mostrarToast('Conta excluída permanentemente.', 'sucesso');
        carregarContasExclusao();
        carregarManicures();
    };

    /* ---------------- CONFIGURAÇÕES GLOBAIS ---------------- */
    function preencherFormConfig() {
        document.getElementById('cfgMensalidade').value = configSistemaCache.mensalidade;
        document.getElementById('cfgChavePix').value = configSistemaCache.chavePix;
        document.getElementById('cfgWhatsapp').value = Agnail.mascararCelular(configSistemaCache.whatsappFinanceiro);
        document.getElementById('cfgDiasTeste').value = configSistemaCache.diasTeste;
    }
    Agnail.aplicarMascaraCelular(document.getElementById('cfgWhatsapp'));

    document.getElementById('formConfigSistema').addEventListener('submit', async function (e) {
        e.preventDefault();
        const novaConfig = {
            mensalidade: parseFloat(document.getElementById('cfgMensalidade').value) || 0,
            chavePix: document.getElementById('cfgChavePix').value.trim(),
            whatsappFinanceiro: document.getElementById('cfgWhatsapp').value.replace(/\D/g, ''),
            diasTeste: parseInt(document.getElementById('cfgDiasTeste').value) || 15
        };
        await Agnail.setConfigSistema(novaConfig);
        configSistemaCache = { ...configSistemaCache, ...novaConfig };
        mostrarToast('Configurações salvas!', 'sucesso');
    });
})();
