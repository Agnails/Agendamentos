/* ==========================================================================
   Agnails - admin-sistema.js
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
    // [ALTERADO] Não guarda mais a lista inteira de manicures — só a
    // página atualmente carregada (50 no máximo) e o paginador que sabe
    // buscar a próxima/anterior direto do Firestore.
    let itensPaginaAtualManicures = [];
    let paginadorManicures = null;

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
        const [classe, texto] = mapa[status] || ['badge-expirado', Agnails.escaparHTML(status)];
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
        const usuarioDoc = await Agnails.db.collection('usuarios').doc(user.uid).get();
        return usuarioDoc.exists && usuarioDoc.data().tipo === 'admin';
    }

    document.getElementById('btnLoginAdmin').addEventListener('click', async function () {
        try {
            const cred = await Agnails.loginGoogle();
            const autorizado = await verificarAdmin(cred.user);
            if (!autorizado) {
                document.getElementById('avisoNegado').classList.add('show');
                await Agnails.logout();
                return;
            }
            iniciarPainel(cred.user);
        } catch (e) {
            console.error(e);
            mostrarToast('Erro ao entrar.', 'erro');
        }
    });

    document.getElementById('btnSairAdmin').addEventListener('click', async function () {
        await Agnails.logout();
        window.location.reload();
    });

    Agnails.onAuthChange(async function (user) {
        if (!user) return;
        const usuarioDoc = await Agnails.db.collection('usuarios').doc(user.uid).get();
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

        configSistemaCache = await Agnails.getConfigSistema();
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
            configSistemaCache = await Agnails.getConfigSistema();
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
    // [ALTERADO] Não busca mais TODAS as manicures de uma vez — pagina de
    // verdade, 50 por página, direto do Firestore (Agnails.criarPaginador,
    // em firebase-config.js). Isso limita o custo de "1 + 3×N" leituras
    // (perfil + assinatura por manicure) a "1 + 3×50" por página, em vez
    // de crescer para sempre com o total de contas cadastradas.
    //
    // [ÍNDICE NECESSÁRIO NO FIRESTORE] A consulta usa
    // where('tipo','==','manicure').orderBy('criadoEm','desc') — na
    // primeira vez que rodar sem o índice composto (tipo ASC + criadoEm
    // DESC) já existir, o Firestore mostra um erro no console com um
    // link pra criar esse índice com um clique.
    function construirQueryManicures() {
        return Agnails.db.collection('usuarios').where('tipo', '==', 'manicure').orderBy('criadoEm', 'desc');
    }

    async function buscarDetalhesManicures(usuarios) {
        const lista = [];
        for (const usuario of usuarios) {
            const uid = usuario.id;
            const [perfil, assinatura] = await Promise.all([
                Agnails.getPerfilCompleto(uid),
                Agnails.getAssinatura(uid)
            ]);
            const statusAcesso = Agnails.calcularStatusAcesso(assinatura);
            lista.push({ uid, usuario, perfil, assinatura, statusAcesso });
        }
        return lista;
    }

    async function carregarManicures() {
        const container = document.getElementById('listaManicures');
        paginadorManicures = Agnails.criarPaginador(construirQueryManicures(), 50);
        container.innerHTML = '<div class="vazio">Carregando...</div>';
        document.getElementById('paginacaoManicures').innerHTML = '';
        let usuarios;
        try {
            usuarios = await paginadorManicures.primeira();
        } catch (e) {
            console.error('Erro ao carregar manicures:', e);
            container.innerHTML = '<div class="vazio">Não foi possível carregar a lista. Tente novamente.</div>';
            return;
        }
        itensPaginaAtualManicures = await buscarDetalhesManicures(usuarios);
        renderizarListaManicures(itensPaginaAtualManicures);
        renderizarStatsPagina(itensPaginaAtualManicures);
        Agnails.renderizarControlesPaginacao('paginacaoManicures', paginadorManicures, irParaPaginaAnteriorManicures, irParaProximaPaginaManicures);
        carregarTotalGeralManicures(); // não bloqueia o resto: atualiza o card sozinho quando terminar
    }

    async function irParaProximaPaginaManicures() {
        if (!paginadorManicures || !paginadorManicures.temProxima()) return;
        const usuarios = await paginadorManicures.proxima();
        itensPaginaAtualManicures = await buscarDetalhesManicures(usuarios);
        renderizarListaManicures(itensPaginaAtualManicures);
        renderizarStatsPagina(itensPaginaAtualManicures);
        Agnails.renderizarControlesPaginacao('paginacaoManicures', paginadorManicures, irParaPaginaAnteriorManicures, irParaProximaPaginaManicures);
    }
    async function irParaPaginaAnteriorManicures() {
        if (!paginadorManicures || !paginadorManicures.temAnterior()) return;
        const usuarios = await paginadorManicures.anterior();
        itensPaginaAtualManicures = await buscarDetalhesManicures(usuarios);
        renderizarListaManicures(itensPaginaAtualManicures);
        renderizarStatsPagina(itensPaginaAtualManicures);
        Agnails.renderizarControlesPaginacao('paginacaoManicures', paginadorManicures, irParaPaginaAnteriorManicures, irParaProximaPaginaManicures);
    }
    // Recarrega a MESMA página depois de uma ação (bloquear, liberar,
    // aprovar pagamento etc.) — evita jogar o admin de volta pra página 1
    // toda vez que uma ação pontual é feita numa página mais adiante.
    async function recarregarPaginaAtualManicures() {
        if (!paginadorManicures) { await carregarManicures(); return; }
        const usuarios = await paginadorManicures.recarregarAtual();
        itensPaginaAtualManicures = await buscarDetalhesManicures(usuarios);
        renderizarListaManicures(itensPaginaAtualManicures);
        renderizarStatsPagina(itensPaginaAtualManicures);
        Agnails.renderizarControlesPaginacao('paginacaoManicures', paginadorManicures, irParaPaginaAnteriorManicures, irParaProximaPaginaManicures);
    }

    function renderizarStatsPagina(lista) {
        const ativos = lista.filter(m => m.statusAcesso.status === 'ativo').length;
        const teste = lista.filter(m => m.statusAcesso.status === 'teste_gratuito').length;
        const pendentes = lista.filter(m => m.statusAcesso.status === 'aguardando_aprovacao').length;
        const expirados = lista.filter(m => m.statusAcesso.status === 'expirado').length;

        // [ALTERADO] "Manicures cadastradas" é o único número realmente
        // GLOBAL (vem de uma contagem separada — ver
        // carregarTotalGeralManicures). Os outros 4 números refletem só a
        // página atual (até 50), porque o status de acesso mora numa
        // subcoleção por manicure e não dá pra contar globalmente sem ler
        // cada uma — que é exatamente o custo que a paginação evita.
        // Rotulados como "nesta página" para não parecerem totais gerais.
        document.getElementById('statsGrid').innerHTML = `
            <div class="stat-card"><div class="num" id="statTotalGeralManicures">…</div><div class="lbl">Manicures cadastradas</div></div>
            <div class="stat-card"><div class="num">${ativos}</div><div class="lbl">Planos ativos (nesta página)</div></div>
            <div class="stat-card"><div class="num">${teste}</div><div class="lbl">Em teste grátis (nesta página)</div></div>
            <div class="stat-card"><div class="num">${pendentes}</div><div class="lbl">Aguardando aprovação (nesta página)</div></div>
            <div class="stat-card"><div class="num">${expirados}</div><div class="lbl">Expirados (nesta página)</div></div>
        `;
    }

    async function carregarTotalGeralManicures() {
        const elemento = document.getElementById('statTotalGeralManicures');
        try {
            const snap = await Agnails.db.collection('usuarios').where('tipo', '==', 'manicure').count().get();
            if (elemento) elemento.textContent = snap.data().count;
        } catch (e) {
            console.error('Erro ao contar total de manicures:', e);
            if (elemento) elemento.textContent = '—';
        }
    }

    function renderizarListaManicures(lista) {
        const container = document.getElementById('listaManicures');
        if (lista.length === 0) {
            container.innerHTML = '<div class="vazio">Nenhuma manicure cadastrada ainda.</div>';
            return;
        }
        container.innerHTML = lista.map(m => {
            const nome = Agnails.escaparHTML(m.perfil?.nomeEmpresa || m.usuario.nome || 'Sem nome');
            const email = Agnails.escaparHTML(m.usuario.email || '');
            const foto = m.usuario.foto
                ? `<img src="${Agnails.escaparAtributo(m.usuario.foto)}" alt="">`
                : `<i class="fa-solid fa-user"></i>`;
            const venc = m.assinatura?.vencimento ? formatarData(m.assinatura.vencimento) : '-';
            const ultimoPag = m.assinatura?.ultimoPagamento ? formatarData(m.assinatura.ultimoPagamento) : '-';
            const diasTeste = m.statusAcesso.status === 'teste_gratuito' ? `${m.statusAcesso.diasRestantesTeste}d` : '-';
            return `
            <div class="manicure-card">
                <div class="manicure-foto">${foto}</div>
                <div class="manicure-info">
                    <div class="nome">${nome}</div>
                    <div class="email">${email}</div>
                </div>
                <div class="manicure-meta">
                    <span>Cadastro: <strong>${formatarData(m.usuario.criadoEm)}</strong></span>
                    <span>Teste restante: <strong>${diasTeste}</strong></span>
                    <span>Vencimento: <strong>${venc}</strong></span>
                    <span>Último pgto: <strong>${ultimoPag}</strong></span>
                </div>
                ${badgeStatus(m.statusAcesso.status)}
                <button class="btn-detalhe" onclick="AgnailsAdmin.abrirDetalhe('${m.uid}')">Detalhes</button>
            </div>`;
        }).join('');
    }

    /* ---------------- MODAL DE DETALHE + GESTÃO ---------------- */
    window.AgnailsAdmin = window.AgnailsAdmin || {};

    window.AgnailsAdmin.abrirDetalhe = function (uid) {
        const m = itensPaginaAtualManicures.find(x => x.uid === uid);
        if (!m) return;
        const nome = Agnails.escaparHTML(m.perfil?.nomeEmpresa || m.usuario.nome || 'Sem nome');
        const responsavel = Agnails.escaparHTML(m.perfil?.nomeResponsavel || '-');
        const email = Agnails.escaparHTML(m.usuario.email || '-');

        document.getElementById('conteudoDetalheManicure').innerHTML = `
            <div class="linha"><span class="lbl">Nome</span><span>${nome}</span></div>
            <div class="linha"><span class="lbl">Responsável</span><span>${responsavel}</span></div>
            <div class="linha"><span class="lbl">E-mail</span><span>${email}</span></div>
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
                <button class="btn-venc" onclick="AgnailsAdmin.salvarVencimento('${uid}')">Salvar vencimento</button>
                ${m.assinatura?.acessoLiberado
                    ? `<button class="btn-bloquear" onclick="AgnailsAdmin.bloquearAcesso('${uid}')">Bloquear acesso</button>`
                    : `<button class="btn-liberar" onclick="AgnailsAdmin.liberarAcesso('${uid}')">Liberar acesso</button>`}
            </div>
        `;
        document.getElementById('overlayDetalheManicure').classList.add('show');
    };

    document.getElementById('fecharDetalheManicure').addEventListener('click', () =>
        document.getElementById('overlayDetalheManicure').classList.remove('show'));

    window.AgnailsAdmin.salvarVencimento = async function (uid) {
        const valor = document.getElementById('inputNovoVencimento').value;
        if (!valor) { mostrarToast('Escolha uma data.', 'erro'); return; }
        const data = new Date(valor + 'T23:59:59');
        await Agnails.manicureRef(uid).collection('meta').doc('assinatura').set({
            vencimento: firebase.firestore.Timestamp.fromDate(data),
            status: 'ativo',
            acessoLiberado: true
        }, { merge: true });
        mostrarToast('Vencimento atualizado!', 'sucesso');
        document.getElementById('overlayDetalheManicure').classList.remove('show');
        recarregarPaginaAtualManicures();
    };

    window.AgnailsAdmin.bloquearAcesso = async function (uid) {
        await Agnails.manicureRef(uid).collection('meta').doc('assinatura').set({
            acessoLiberado: false, status: 'expirado'
        }, { merge: true });
        mostrarToast('Acesso bloqueado.', 'sucesso');
        document.getElementById('overlayDetalheManicure').classList.remove('show');
        recarregarPaginaAtualManicures();
    };

    window.AgnailsAdmin.liberarAcesso = async function (uid) {
        // [CORRIGIDO] As regras do Firestore agora exigem que, para
        // status "ativo", o campo "vencimento" seja uma data futura (ver
        // assinaturaAtiva() em REGRAS_DE_SEGURANÇA.txt). Antes, este
        // botão só setava acessoLiberado/status e deixava "vencimento"
        // como estava — se a conta já tivesse um vencimento vencido (ou
        // nunca tivesse um), a liberação "funcionava" na tela mas as
        // escritas seguintes do painel da manicure (agendar, concluir
        // atendimento etc.) continuavam sendo rejeitadas pelo servidor.
        // Por padrão, dá-se 30 dias de acesso; o admin pode ajustar a
        // data específica depois em "Salvar vencimento", se preferir.
        const novoVencimento = new Date();
        novoVencimento.setDate(novoVencimento.getDate() + 30);
        await Agnails.manicureRef(uid).collection('meta').doc('assinatura').set({
            acessoLiberado: true, status: 'ativo',
            vencimento: firebase.firestore.Timestamp.fromDate(novoVencimento)
        }, { merge: true });
        mostrarToast('Acesso liberado (vencimento em 30 dias).', 'sucesso');
        document.getElementById('overlayDetalheManicure').classList.remove('show');
        recarregarPaginaAtualManicures();
    };

    /* ---------------- PAGAMENTOS PENDENTES ---------------- */
    async function carregarPagamentosPendentes() {
        const pendentesSnap = await Agnails.db.collection('administracao').doc('pagamentosPendentes').collection('itens').get();
        const container = document.getElementById('listaPagamentos');

        if (pendentesSnap.empty) {
            container.innerHTML = '<div class="vazio">Nenhum pagamento aguardando aprovação.</div>';
            return;
        }

        const cartoes = [];
        for (const item of pendentesSnap.docs) {
            const { uid, pagamentoId } = item.data();
            const pagamentoSnap = await Agnails.manicureRef(uid).collection('pagamentos').doc(pagamentoId).get();
            if (!pagamentoSnap.exists) continue;
            const pagamento = pagamentoSnap.data();
            if (pagamento.status !== 'aguardando_aprovacao') continue;

            const perfil = await Agnails.getPerfil(uid);
            const nome = Agnails.escaparHTML(perfil?.nomeEmpresa || uid);
            const competencia = Agnails.escaparHTML(pagamento.competencia || '');
            const comprovanteSeguro = (typeof pagamento.comprovante === 'string' &&
                /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(pagamento.comprovante))
                ? pagamento.comprovante
                : '';

            cartoes.push(`
                <div class="pagamento-card">
                    <div class="pagamento-topo">
                        <span class="nome">${nome}</span>
                        <span class="valor">R$ ${Number(pagamento.valor || 0).toFixed(2).replace('.', ',')}</span>
                    </div>
                    <div style="font-size:0.8rem; color:var(--texto-claro);">Competência: ${competencia} • Enviado em ${formatarData(pagamento.enviadoEm)}</div>
                    ${comprovanteSeguro
                        ? `<img class="comprovante-img" src="${comprovanteSeguro}" onclick="AgnailsAdmin.ampliarComprovante(this.src)">`
                        : `<p style="color:var(--vermelho-escuro); font-size:0.82rem;">Comprovante inválido ou corrompido — peça um novo envio.</p>`}
                    <textarea class="obs" id="obs-${pagamentoId}" placeholder="Observações (opcional)"></textarea>
                    <div class="acoes-pagamento">
                        <button class="btn-aprovar" onclick="AgnailsAdmin.aprovarPagamento('${uid}','${pagamentoId}')">Aprovar</button>
                        <button class="btn-rejeitar" onclick="AgnailsAdmin.rejeitarPagamento('${uid}','${pagamentoId}')">Rejeitar</button>
                    </div>
                </div>
            `);
        }
        container.innerHTML = cartoes.length ? cartoes.join('') : '<div class="vazio">Nenhum pagamento aguardando aprovação.</div>';
    }

    window.AgnailsAdmin.ampliarComprovante = function (src) {
        document.getElementById('imgComprovanteAmpliado').src = src;
        document.getElementById('overlayComprovanteAmpliado').classList.add('show');
    };
    document.getElementById('fecharComprovanteAmpliado').addEventListener('click', () =>
        document.getElementById('overlayComprovanteAmpliado').classList.remove('show'));

    window.AgnailsAdmin.aprovarPagamento = async function (uid, pagamentoId) {
        const obs = document.getElementById('obs-' + pagamentoId)?.value || '';
        const agora = firebase.firestore.Timestamp.now();

        // [ALTERADO] Antes buscava o vencimento atual em manicuresCache
        // (a lista completa em memória). Com a lista paginada, a
        // manicure sendo aprovada aqui pode não estar na página
        // atualmente carregada — por isso agora busca só o documento de
        // assinatura dela, direto (uma leitura simples e barata).
        let vencimentoAtual = null;
        try {
            const assinaturaSnap = await Agnails.manicureRef(uid).collection('meta').doc('assinatura').get();
            if (assinaturaSnap.exists && assinaturaSnap.data().vencimento) {
                vencimentoAtual = assinaturaSnap.data().vencimento.toDate();
            }
        } catch (e) {
            console.error('Erro ao buscar assinatura para aprovação:', e);
        }
        // A validade sempre soma 30 dias por mensalidade. Se a assinatura
        // atual ainda não venceu, os 30 dias somam a partir do vencimento
        // atual (para não "perder" dias já pagos); caso já tenha expirado,
        // conta a partir de hoje.
        const baseData = (vencimentoAtual && vencimentoAtual.getTime() > Date.now()) ? vencimentoAtual : new Date();
        const novoVencimento = new Date(baseData);
        novoVencimento.setDate(novoVencimento.getDate() + 30);

        await Agnails.manicureRef(uid).collection('pagamentos').doc(pagamentoId).set({
            status: 'aprovado', observacoes: obs, aprovadoEm: agora, aprovadoPor: adminAtual.email
        }, { merge: true });

        await Agnails.manicureRef(uid).collection('meta').doc('assinatura').set({
            status: 'ativo', acessoLiberado: true, ultimoPagamento: agora,
            vencimento: firebase.firestore.Timestamp.fromDate(novoVencimento)
        }, { merge: true });

        await Agnails.db.collection('administracao').doc('pagamentosPendentes').collection('itens').doc(pagamentoId).delete();

        mostrarToast('Pagamento aprovado!', 'sucesso');
        carregarPagamentosPendentes();
        recarregarPaginaAtualManicures();
    };

    window.AgnailsAdmin.rejeitarPagamento = async function (uid, pagamentoId) {
        const obs = document.getElementById('obs-' + pagamentoId)?.value || '';
        await Agnails.manicureRef(uid).collection('pagamentos').doc(pagamentoId).set({
            status: 'rejeitado', observacoes: obs
        }, { merge: true });
        await Agnails.manicureRef(uid).collection('meta').doc('assinatura').set({
            status: 'expirado', acessoLiberado: false
        }, { merge: true });
        await Agnails.db.collection('administracao').doc('pagamentosPendentes').collection('itens').doc(pagamentoId).delete();

        mostrarToast('Pagamento rejeitado.', 'sucesso');
        carregarPagamentosPendentes();
        recarregarPaginaAtualManicures();
    };

    /* ---------------- CONTAS PENDENTES DE EXCLUSÃO ---------------- */
    async function carregarContasExclusao() {
        const snap = await Agnails.db.collection('administracao').doc('contasPendentesExclusao').collection('contas').get();
        const container = document.getElementById('listaExclusoes');

        if (snap.empty) {
            container.innerHTML = '<div class="vazio">Nenhuma conta pendente de exclusão.</div>';
            return;
        }

        const cartoes = [];
        for (const doc of snap.docs) {
            const dados = doc.data();
            const uid = doc.id;
            const usuario = await Agnails.getUsuario(uid);
            if (!usuario) continue;
            const diasDecorridos = Math.floor((Date.now() - dados.dataSolicitacaoExclusao.toDate()) / 86400000);
            const disponivelHoje = Date.now() >= dados.dataExclusaoPermitida.toDate().getTime();

            cartoes.push(`
                <div class="exclusao-card">
                    <div class="manicure-foto">${usuario.foto ? `<img src="${Agnails.escaparAtributo(usuario.foto)}">` : '<i class="fa-solid fa-user"></i>'}</div>
                    <div class="manicure-info">
                        <div class="nome">${Agnails.escaparHTML(usuario.nome || '-')}</div>
                        <div class="email">${Agnails.escaparHTML(usuario.email || '-')}</div>
                    </div>
                    <div class="manicure-meta">
                        <span>Solicitado em: <strong>${formatarData(dados.dataSolicitacaoExclusao)}</strong></span>
                        <span>Exclusão liberada em: <strong>${formatarData(dados.dataExclusaoPermitida)}</strong></span>
                        <span>Dias decorridos: <strong>${diasDecorridos}</strong></span>
                    </div>
                    <button class="btn-reativar" onclick="AgnailsAdmin.reativarConta('${uid}')">Reativar Conta</button>
                    <button class="btn-excluir-perm" ${disponivelHoje ? '' : 'disabled title="Ainda dentro do período de retenção de 90 dias"'} onclick="AgnailsAdmin.excluirPermanente('${uid}')">Excluir Permanentemente</button>
                </div>
            `);
        }
        container.innerHTML = cartoes.join('');
    }

    window.AgnailsAdmin.reativarConta = async function (uid) {
        await Agnails.db.collection('usuarios').doc(uid).set({ statusConta: 'ativa' }, { merge: true });
        await Agnails.manicureRef(uid).collection('meta').doc('assinatura').set({
            dataSolicitacaoExclusao: null, dataExclusaoPermitida: null
        }, { merge: true });
        await Agnails.db.collection('administracao').doc('contasPendentesExclusao').collection('contas').doc(uid).delete();
        mostrarToast('Conta reativada!', 'sucesso');
        carregarContasExclusao();
        recarregarPaginaAtualManicures();
    };

    window.AgnailsAdmin.excluirPermanente = async function (uid) {
        if (!confirm('Esta ação é irreversível e removerá todos os dados desta manicure. Continuar?')) return;
        try {
            await Agnails.excluirContaPermanentemente(uid);
        } catch (e) {
            console.error('Erro ao excluir conta permanentemente:', e);
            mostrarToast('Erro ao excluir a conta. Tente novamente.', 'erro');
            return;
        }
        mostrarToast('Conta excluída permanentemente.', 'sucesso');
        carregarContasExclusao();
        recarregarPaginaAtualManicures();
    };

    /* ---------------- CONFIGURAÇÕES GLOBAIS ---------------- */
    function preencherFormConfig() {
        document.getElementById('cfgMensalidade').value = configSistemaCache.mensalidade;
        document.getElementById('cfgChavePix').value = configSistemaCache.chavePix;
        document.getElementById('cfgWhatsapp').value = Agnails.mascararCelular(configSistemaCache.whatsappFinanceiro);
        document.getElementById('cfgDiasTeste').value = configSistemaCache.diasTeste;
    }
    Agnails.aplicarMascaraCelular(document.getElementById('cfgWhatsapp'));

    document.getElementById('formConfigSistema').addEventListener('submit', async function (e) {
        e.preventDefault();
        const novaConfig = {
            mensalidade: parseFloat(document.getElementById('cfgMensalidade').value) || 0,
            chavePix: document.getElementById('cfgChavePix').value.trim(),
            whatsappFinanceiro: document.getElementById('cfgWhatsapp').value.replace(/\D/g, ''),
            diasTeste: parseInt(document.getElementById('cfgDiasTeste').value) || 15
        };
        await Agnails.setConfigSistema(novaConfig);
        configSistemaCache = { ...configSistemaCache, ...novaConfig };
        mostrarToast('Configurações salvas!', 'sucesso');
    });
})();
