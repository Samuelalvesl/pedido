/*
 * PEDIDO — distribuição de pedidos para atletas
 * Autenticação: Firebase Authentication (e-mail e senha)
 * Banco de dados: Cloud Firestore
 *
 * Nenhuma senha fica neste código nem no banco. As permissões, os limites e a
 * baixa no estoque são garantidos pelas regras do Firestore (firestore.rules),
 * não apenas por esta tela.
 */
(async function () {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
  const MAX_ITENS_POR_SOLICITACAO = 6; // mesmo valor das regras do Firestore
  const app = document.getElementById('app');
  const $ = id => document.getElementById(id);
  const CARREGANDO = '<div class="carregando">Carregando…</div>';

  const MODALIDADES_INICIAIS = [
    'Futebol', 'Futsal', 'Vôlei', 'Basquete', 'Handebol', 'Atletismo',
    'Natação', 'Judô', 'Tênis de Mesa', 'Xadrez', 'Ciclismo'
  ];
  const UNIDADES = ['un', 'pct', 'cx', 'kg', 'g', 'L', 'ml'];

  /* ---------- Configuração ---------- */
  const cfg = window.FIREBASE_CONFIG || {};
  if (!cfg.apiKey || cfg.apiKey === 'COLE_AQUI') {
    app.innerHTML = `<div class="login-wrap"><div class="card login">
      <span class="marca">Configuração pendente</span>
      <h1>Firebase não configurado</h1>
      <p class="muted">Preencha o arquivo <strong>js/firebase-config.js</strong> com os dados do seu projeto Firebase.</p>
    </div></div>`;
    return;
  }

  let fbApp, fbAuth, fbStore;
  try {
    [fbApp, fbAuth, fbStore] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-firestore.js')
    ]);
  } catch (e) {
    app.innerHTML = `<div class="login-wrap"><div class="card login">
      <h1>Sem conexão</h1>
      <p class="muted">Não foi possível carregar o sistema. Verifique a internet e recarregue a página.</p>
    </div></div>`;
    return;
  }

  const { initializeApp, deleteApp } = fbApp;
  const {
    getAuth, initializeAuth, inMemoryPersistence, signInWithEmailAndPassword, signOut,
    onAuthStateChanged, createUserWithEmailAndPassword, sendPasswordResetEmail
  } = fbAuth;
  const {
    getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
    query, where, serverTimestamp, writeBatch, increment
  } = fbStore;

  const firebaseApp = initializeApp(cfg);
  const auth = getAuth(firebaseApp);
  const db = getFirestore(firebaseApp);

  /* ---------- Estado ---------- */
  let perfil = null;        // { uid, nome, email, perfil, modalidadeId }
  let mensagemLogin = '';
  let dados = vazio();
  let filtroSolicitacoes = 'todas';
  let filtroData = 'todas';   // data da retirada selecionada no painel de solicitações
  // Quem está usando o painel de solicitações (Administrador ou Paioleiro).
  const CTX_ADMIN = { papel: 'admin', recarregar: msg => telaAdmin('solicitacoes', msg, true) };
  const CTX_PAIOLEIRO = { papel: 'paioleiro', recarregar: msg => telaPaioleiro(msg) };
  // Perfil "paioleiro" (o valor antigo "catanheiro" continua aceito para acessos já criados).
  const ehPerfilPaioleiro = u => !!u && (u.perfil === 'paioleiro' || u.perfil === 'catanheiro');
  let ctxSol = CTX_ADMIN;

  function vazio() {
    return { modalidades: [], eventos: [], usuarios: [], solicitacoes: [], itens: [], movimentos: [], exclusoes: [] };
  }

  /* ---------- Utilitários ---------- */
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtData(iso) {
    if (!iso) return '—';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  }
  function fmtDataHora(ts) {
    if (!ts || !ts.toDate) return '—';
    const d = ts.toDate();
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const ms = ts => (ts && ts.toMillis) ? ts.toMillis() : 0;
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const pedidos = n => plural(n, 'pedido', 'pedidos');

  // ---------- Datas, prazo e retirada (horário de Brasília, GMT-3, sem horário de verão) ----------
  const FUSO_BRASILIA_MS = 3 * 60 * 60 * 1000;
  const HORA_LIMITE = 9, MINUTO_LIMITE = 30;  // solicitações até 9h30 do próprio dia da retirada
  const PRAZO_TEXTO = '9h30';
  const HORARIO_RETIRADA = '10:00 às 11:00';   // valor gravado na solicitação
  const RETIRADA_TEXTO = '10h às 11h';         // como é exibido
  const NOMES_MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const NOMES_DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const isoData = (a, m, d) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  function hojeISO() {
    const b = new Date(Date.now() - FUSO_BRASILIA_MS); // campos UTC = horário de Brasília
    return isoData(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate());
  }
  // Instante (UTC) em que encerra o prazo da data: 9h30 de Brasília = 12h30 UTC.
  function prazoDaData(dt) {
    const [a, m, d] = dt.split('-').map(Number);
    return Date.UTC(a, m - 1, d, HORA_LIMITE, MINUTO_LIMITE) + FUSO_BRASILIA_MS;
  }
  function situacaoData(dt) {
    if (!dt || dt < hojeISO()) return 'passada';
    return Date.now() >= prazoDaData(dt) ? 'encerrada' : 'aberta';
  }
  function fmtDataSemana(dt) {
    if (!dt) return '—';
    const [a, m, d] = dt.split('-').map(Number);
    return `${fmtData(dt)} (${NOMES_DIAS[new Date(Date.UTC(a, m - 1, d)).getUTCDay()]})`;
  }

  function msgErro(e) {
    const c = (e && e.code) || '';
    if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email', 'auth/invalid-login-credentials'].includes(c))
      return 'E-mail ou senha inválidos.';
    if (c === 'auth/too-many-requests') return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    if (c === 'auth/email-already-in-use') return 'Este e-mail já possui um login no Firebase Authentication (pode ser de um usuário excluído). Remova-o em Firebase → Authentication → Usuários e tente novamente.';
    if (c === 'auth/weak-password') return 'A senha deve ter pelo menos 6 caracteres.';
    if (c === 'auth/network-request-failed' || c === 'unavailable') return 'Sem conexão com a internet. Tente novamente.';
    if (c === 'permission-denied') return 'Você não tem permissão para realizar esta operação.';
    return 'Ocorreu um erro inesperado' + (c ? ` (${c})` : '') + '.';
  }
  async function comBotao(btn, fn) {
    btn.disabled = true;
    try { await fn(); } finally { if (btn.isConnected) btn.disabled = false; }
  }
  async function lista(nome) {
    const s = await getDocs(collection(db, nome));
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function listaConsulta(q) {
    const s = await getDocs(q);
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  // Quantidades: somente números inteiros.
  function paraInteiro(txt) {
    const t = String(txt ?? '').trim();
    if (t === '') return null;
    if (!/^\d+$/.test(t)) return NaN;
    return Number(t);
  }
  const fmtQtd = n => Number(n || 0).toLocaleString('pt-BR');
  const qtdUn = (n, un) => `${fmtQtd(n)} ${un || ''}`.trim();
  const editavel = n => n == null ? '' : String(n);
  const inteiro = txt => {
    const t = String(txt ?? '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isInteger(n) ? n : NaN;
  };

  const modalidade = id => dados.modalidades.find(m => m.id === id);
  const evento = id => dados.eventos.find(e => e.id === id);
  const item = id => dados.itens.find(i => i.id === id);
  // Fluxo: pendente -> recebido ("Pedido Recebido") -> fornecido ("Fornecido" + baixa no estoque).
  // "atendido" existe apenas em solicitações antigas (anteriores a este fluxo).
  const statusDe = s => ['recebido', 'fornecido', 'atendido'].includes(s.status) ? s.status : 'pendente';
  const grupoDe = s => ({ pendente: 'pendentes', recebido: 'recebidos', fornecido: 'fornecidos', atendido: 'fornecidos' })[statusDe(s)];
  const classeLinha = s => ({ pendente: 'linha-pendente', recebido: 'linha-recebida', fornecido: 'linha-atendida', atendido: 'linha-atendida' })[statusDe(s)];
  // Solicitações novas baixam o estoque no "Fornecido"; as antigas já baixaram ao serem criadas.
  const baixaNoFornecimento = s => s.baixaNoFornecimento === true;
  const estoqueBaixado = s => baixaNoFornecimento(s) ? statusDe(s) === 'fornecido' : true;
  const dataDaBaixa = s => baixaNoFornecimento(s) ? s.fornecidoEm : s.criadoEm;

  // Data da retirada. Solicitações antigas (anteriores ao calendário) usam a data do evento.
  const dataDe = s => s.data || evento(s.eventoId)?.data || '';
  const itensOrdenados = () => dados.itens.slice().sort((a, b) => a.nome.localeCompare(b.nome));
  const ordenarModalidades = l => l.slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.nome.localeCompare(b.nome));
  const itensDaSolicitacao = s => Object.entries(s.itens || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => a.nome.localeCompare(b.nome));

  // Quantidade efetivamente fornecida de um item (quando a solicitação já foi fornecida).
  const qtdFornecida = (s, i) => (s.fornecidos && s.fornecidos[i.id] != null) ? s.fornecidos[i.id] : i.quantidade;
  const textoRetirada = s => s.data ? RETIRADA_TEXTO : (s.horarioRetirada || '—');
  function listaItensHtml(s) {
    const l = itensDaSolicitacao(s);
    if (!l.length) return '<span class="muted">—</span>';
    return `<ul class="lista-itens">${l.map(i => {
      const f = qtdFornecida(s, i);
      return s.fornecidos && f !== i.quantidade
        ? `<li>${esc(i.nome)}: <strong>${esc(qtdUn(f, i.unidade))}</strong> <span class="muted">(aprovado ${esc(qtdUn(i.quantidade, i.unidade))})</span></li>`
        : `<li>${esc(i.nome)}: <strong>${esc(qtdUn(i.quantidade, i.unidade))}</strong></li>`;
    }).join('')}</ul>`;
  }
  // "Registro de Alterações na Quantidade": somente itens com redução.
  function tabelaRegistro(alteracoes, porNome, quando) {
    const l = Object.values(alteracoes || {}).sort((a, b) => a.nome.localeCompare(b.nome));
    if (!l.length) return '<p class="muted small registro-vazio">Nenhuma alteração: quantidade fornecida igual à aprovada.</p>';
    return `<div class="tabela-wrap registro"><table>
      <thead><tr><th>Item</th><th class="num">Aprovada</th><th class="num">Fornecida</th><th class="num">Diferença</th><th>Paioleiro</th><th>Data e horário</th><th>Justificativa</th></tr></thead>
      <tbody>${l.map(r => `<tr>
        <td>${esc(r.nome)}</td>
        <td class="num">${esc(qtdUn(r.aprovada, r.unidade))}</td>
        <td class="num">${esc(qtdUn(r.fornecida, r.unidade))}</td>
        <td class="num"><strong>−${esc(qtdUn(r.diferenca, r.unidade))}</strong></td>
        <td>${esc(porNome || '—')}</td>
        <td>${esc(quando)}</td>
        <td>${r.justificativa ? esc(r.justificativa) : '<span class="muted">não informada</span>'}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  const temAlteracoes = s => !!s.alteracoes && Object.keys(s.alteracoes).length > 0;
  function seloStatus(s) {
    return {
      pendente: '<span class="status pendente">● Pendente</span>',
      recebido: '<span class="status recebido">◐ Pedido Recebido</span>',
      fornecido: '<span class="status atendido">✓ Fornecido</span>',
      atendido: '<span class="status atendido">✓ Atendido</span>'
    }[statusDe(s)];
  }
  function historicoStatus(s) {
    const linhas = [];
    if (s.recebidoEm) linhas.push(`Recebido: ${fmtDataHora(s.recebidoEm)} por ${esc(s.recebidoPorNome || '—')}`);
    if (s.fornecidoEm) linhas.push(`Fornecido: ${fmtDataHora(s.fornecidoEm)} por ${esc(s.fornecidoPorNome || '—')}`);
    if (s.atendidoEm) linhas.push(`Atendido: ${fmtDataHora(s.atendidoEm)} por ${esc(s.atendidoPorNome || '—')}`);
    return linhas.length ? `<div class="atendimento">${linhas.join('<br>')}</div>` : '';
  }

  async function sair(mensagem) {
    mensagemLogin = mensagem || '';
    dados = vazio();
    mesCalendario = null;   // o calendário volta ao mês atual no próximo acesso
    dataSelecionada = null;
    filtroData = 'todas';
    await signOut(auth);
  }

  /* ---------- Sessão ---------- */
  onAuthStateChanged(auth, async user => {
    if (!user) { perfil = null; return telaLogin(); }
    app.innerHTML = CARREGANDO;
    try {
      const s = await getDoc(doc(db, 'usuarios', user.uid));
      if (!s.exists()) return sair('Seu acesso não está ativo (não configurado ou excluído). Procure o Administrador.');
      perfil = { uid: user.uid, ...s.data() };
      if (perfil.perfil === 'admin') { filtroSolicitacoes = 'todas'; ctxSol = CTX_ADMIN; return telaAdmin('solicitacoes', '', true); }
      if (ehPerfilPaioleiro(perfil)) { filtroSolicitacoes = 'recebidos'; ctxSol = CTX_PAIOLEIRO; return telaPaioleiro(); }
      if (perfil.perfil === 'responsavel' && perfil.modalidadeId) return telaResponsavel();
      return sair('Usuário sem modalidade vinculada. Procure o Administrador.');
    } catch (e) {
      return sair(msgErro(e));
    }
  });

  function cabecalho(sub, comAtualizar) {
    return `<header class="topo">
      <div><strong>PEDIDO</strong> <span class="sub">· ${esc(sub)}</span></div>
      <div class="topo-dir">
        <span>${esc(perfil.nome)}</span>
        ${comAtualizar ? '<button class="btn claro pequeno" id="btnAtualizar">Atualizar</button>' : ''}
        <button class="btn claro pequeno" id="btnSair">Sair</button>
      </div>
    </header>`;
  }
  function ligarSair() { $('btnSair').onclick = () => sair(); }

  function telaFalha(sub, e, tentarDeNovo) {
    app.innerHTML = cabecalho(sub) + `<main class="conteudo estreito"><section class="card">
      <h2>Não foi possível carregar os dados</h2>
      <div class="erro">${esc(msgErro(e))}</div>
      <button class="btn primario" id="btnTentar">Tentar novamente</button>
    </section></main>`;
    ligarSair();
    $('btnTentar').onclick = tentarDeNovo;
  }

  /* ---------- Login ---------- */
  function telaLogin() {
    const msg = mensagemLogin; mensagemLogin = '';
    app.innerHTML = `
    <div class="login-wrap">
      <form class="card login" id="fLogin" novalidate>
        <span class="marca">PEDIDO</span>
        <h1>Acesso ao sistema</h1>
        <p class="muted" style="margin-top:-.3rem;margin-bottom:1.2rem">Distribuição de pedidos para atletas</p>
        <label>Usuário/e-mail<input type="email" name="email" autocomplete="username" placeholder="seu@email.com"></label>
        <label>Senha<input type="password" name="senha" autocomplete="current-password"></label>
        <div class="erro" id="erroLogin">${esc(msg)}</div>
        <button class="btn primario" type="submit" id="btnEntrar">Entrar</button>
      </form>
    </div>`;
    $('fLogin').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const email = String(f.get('email')).trim();
      const senha = String(f.get('senha'));
      if (!email || !senha) { $('erroLogin').textContent = 'Informe o usuário/e-mail e a senha.'; return; }
      comBotao($('btnEntrar'), async () => {
        try { await signInWithEmailAndPassword(auth, email, senha); }
        catch (err) { if ($('erroLogin')) $('erroLogin').textContent = msgErro(err); }
      });
    };
  }

  /* ================= Responsável ================= */
  let mesCalendario = null;   // { ano, mes (1-12) } exibido no calendário
  let dataSelecionada = null; // 'AAAA-MM-DD'

  async function telaResponsavel(mensagem) {
    app.innerHTML = CARREGANDO;
    let mod;
    try {
      const [mSnap, eventos, itens, solicitacoes] = await Promise.all([
        getDoc(doc(db, 'modalidades', perfil.modalidadeId)),
        // Eventos: apenas para exibir a data de solicitações antigas (anteriores ao calendário).
        listaConsulta(query(collection(db, 'eventos'), where('modalidadeId', '==', perfil.modalidadeId))).catch(() => []),
        lista('itens'),
        listaConsulta(query(collection(db, 'solicitacoes'), where('modalidadeId', '==', perfil.modalidadeId)))
      ]);
      if (!mSnap.exists()) return sair('A modalidade vinculada ao seu acesso não foi encontrada. Procure o Administrador.');
      mod = { id: mSnap.id, ...mSnap.data() };
      dados = { ...vazio(), modalidades: [mod], eventos, itens, solicitacoes };
    } catch (e) {
      return telaFalha('Solicitação de pedidos', e, () => telaResponsavel());
    }

    const minhas = dados.solicitacoes.slice().sort((a, b) => dataDe(b).localeCompare(dataDe(a)) || ms(b.criadoEm) - ms(a.criadoEm));
    app.innerHTML = cabecalho('Solicitação de pedidos') + `
    <main class="conteudo estreito">
      ${mensagem ? `<div class="aviso">${esc(mensagem)}</div>` : ''}
      <section class="card" id="secCalendario"></section>
      <section class="card" id="secSolicitacao" hidden></section>
      <section class="card">
        <h2>Solicitações da modalidade</h2>
        ${minhas.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Data da retirada</th><th>Retirada</th><th class="num">Quantidade</th><th>Itens</th><th>Status</th><th>Registrada em</th></tr></thead>
          <tbody>${minhas.map(s => `<tr class="${classeLinha(s)}">
            <td><strong>${esc(fmtDataSemana(dataDe(s)))}</strong></td>
            <td>${esc(textoRetirada(s))}</td>
            <td class="num">${fmtQtd(s.quantidade)}</td>
            <td>${listaItensHtml(s)}</td>
            <td>${seloStatus(s)}</td>
            <td>${fmtDataHora(s.criadoEm)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma solicitação registrada.</p>'}
      </section>
    </main>`;
    ligarSair();
    if (!mesCalendario) { const h = hojeISO(); mesCalendario = { ano: +h.slice(0, 4), mes: +h.slice(5, 7) }; }
    dataSelecionada = null;
    desenharCalendario(mod);
  }

  function msgLimiteModalidade(m) {
    return m.limite == null
      ? 'O limite de pedidos desta modalidade ainda não foi definido pelo Administrador.'
      : `Quantidade máxima permitida para esta modalidade: ${pedidos(m.limite)}.`;
  }
  const msgPrazoEncerrado = dt => `O prazo para solicitar para ${fmtData(dt)} encerrou às ${PRAZO_TEXTO} (horário de Brasília). Não é mais possível solicitar para esta data.`;
  const MSG_DATA_PASSADA = 'Não é possível solicitar para datas anteriores a hoje.';
  const MSG_DUPLICADA = 'Já existe uma solicitação da sua modalidade para esta data. É permitida apenas uma solicitação por data.';

  // ---------- Calendário ----------
  function desenharCalendario(mod, aviso) {
    const { ano, mes } = mesCalendario;
    const hoje = hojeISO();
    const mesAtual = hoje.slice(0, 7) === `${ano}-${String(mes).padStart(2, '0')}`;
    const primeiroDiaSemana = new Date(Date.UTC(ano, mes - 1, 1)).getUTCDay();
    const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const jaPedido = dt => dados.solicitacoes.some(s => dataDe(s) === dt);

    let celulas = '';
    for (let i = 0; i < primeiroDiaSemana; i++) celulas += '<div class="dia vazio"></div>';
    for (let dia = 1; dia <= diasNoMes; dia++) {
      const dt = isoData(ano, mes, dia);
      const sit = situacaoData(dt);
      const pedido = jaPedido(dt);
      const classes = ['dia', sit, dt === hoje ? 'hoje' : '', pedido ? 'solicitado' : '', dt === dataSelecionada ? 'selecionado' : ''].join(' ');
      const titulo = sit === 'passada' ? 'Data anterior a hoje'
        : sit === 'encerrada' ? `Prazo encerrado (${PRAZO_TEXTO})`
        : pedido ? 'Já solicitado' : 'Disponível';
      celulas += `<button type="button" class="${classes}" data-dia="${dt}" ${sit === 'passada' ? 'disabled' : ''} title="${titulo}" aria-label="${fmtData(dt)}: ${titulo}">
        <span class="num-dia">${dia}</span>${pedido ? '<span class="marca-dia">✓</span>' : sit === 'encerrada' ? '<span class="marca-dia">⏱</span>' : ''}
      </button>`;
    }

    $('secCalendario').innerHTML = `
      <h2>Escolha a data da retirada</h2>
      <p class="muted small" style="margin-top:-.3rem">Solicitações até as <strong>${PRAZO_TEXTO} do próprio dia</strong> da retirada (horário de Brasília). Retirada sempre das <strong>${RETIRADA_TEXTO}</strong>.</p>
      <div class="calendario">
        <div class="cal-topo">
          <button type="button" class="btn secundario pequeno" id="calAnt" ${mesAtual ? 'disabled' : ''} aria-label="Mês anterior">‹</button>
          <strong>${NOMES_MESES[mes - 1]} de ${ano}</strong>
          <button type="button" class="btn secundario pequeno" id="calProx" aria-label="Próximo mês">›</button>
        </div>
        <div class="cal-semana">${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map(d => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grade">${celulas}</div>
        <div class="cal-legenda">
          <span><i class="leg disponivel"></i>Disponível</span>
          <span><i class="leg solicitado"></i>Já solicitado</span>
          <span><i class="leg encerrada"></i>Prazo encerrado</span>
        </div>
      </div>
      <div class="erro" id="erroCal" style="margin-top:.8rem">${esc(aviso || '')}</div>`;

    $('calAnt').onclick = () => { mesCalendario = mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 }; desenharCalendario(mod); };
    $('calProx').onclick = () => { mesCalendario = mes === 12 ? { ano: ano + 1, mes: 1 } : { ano, mes: mes + 1 }; desenharCalendario(mod); };
    document.querySelectorAll('[data-dia]').forEach(b => b.onclick = () => {
      const dt = b.dataset.dia;
      const sit = situacaoData(dt);
      if (sit === 'passada') return desenharCalendario(mod, MSG_DATA_PASSADA);
      if (sit === 'encerrada') { dataSelecionada = null; $('secSolicitacao').hidden = true; return desenharCalendario(mod, msgPrazoEncerrado(dt)); }
      if (jaPedido(dt)) { dataSelecionada = null; $('secSolicitacao').hidden = true; return desenharCalendario(mod, MSG_DUPLICADA); }
      dataSelecionada = dt;
      desenharCalendario(mod);
      formularioSolicitacao(mod, { data: dt });
      $('secSolicitacao').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  }

  // Validação usada no formulário e novamente antes de gravar (com dados atualizados).
  // Cada item marcado recebe a mesma quantidade solicitada.
  // A baixa no estoque só ocorre quando o pedido é marcado como "Fornecido".
  function validarSolicitacao(mod, d, catalogo) {
    const erros = [], itens = [];
    const sit = situacaoData(d.data);
    if (sit === 'passada') erros.push(MSG_DATA_PASSADA);
    if (sit === 'encerrada') erros.push(msgPrazoEncerrado(d.data));
    if (mod.limite == null || d.quantidade > mod.limite) erros.push(msgLimiteModalidade(mod));
    if (!d.itemIds.length) erros.push('Selecione pelo menos um item para compor o pedido.');
    if (d.itemIds.length > MAX_ITENS_POR_SOLICITACAO) erros.push(`Selecione no máximo ${MAX_ITENS_POR_SOLICITACAO} itens por solicitação.`);
    for (const id of d.itemIds) {
      const atual = catalogo.find(c => c.id === id);
      if (!atual || !atual.ativo) { erros.push('Um dos itens selecionados não está mais disponível.'); continue; }
      const total = d.quantidade;
      if (total > atual.saldo)
        erros.push(`${atual.nome}: estoque insuficiente (necessário ${qtdUn(total, atual.unidade)}; disponível ${qtdUn(Math.max(atual.saldo, 0), atual.unidade)}).`);
      itens.push({ id, nome: atual.nome, unidade: atual.unidade, quantidade: total });
    }
    return { erros, itens };
  }

  function formularioSolicitacao(mod, valores) {
    const disponiveis = itensOrdenados().filter(i => i.ativo);
    const marcado = id => (valores.itemIds || []).includes(id);
    const sec = $('secSolicitacao');
    sec.hidden = false;
    sec.innerHTML = `
      <h2>Solicitação de pedidos</h2>
      <form id="fSol" novalidate>
        <label>Modalidade<input value="${esc(mod.nome)}" readonly></label>
        <label>Data da retirada<input id="inpData" value="${esc(fmtDataSemana(valores.data))}" readonly></label>
        <div class="retirada-fixa">
          <span class="rotulo">Horário de retirada</span>
          <strong>${RETIRADA_TEXTO}</strong>
          <span class="small">Horário fixo para todas as solicitações.</span>
        </div>
        <p class="muted small" style="margin-top:-.3rem">Prazo para enviar: até as ${PRAZO_TEXTO} de ${esc(fmtData(valores.data))} (horário de Brasília). É permitida apenas uma solicitação por data.</p>
        <label>Quantidade
          <input type="number" id="inpQtd" min="1" step="1" inputmode="numeric" value="${editavel(valores.quantidade)}">
        </label>
        <p class="muted small" style="margin-top:-.5rem">
          ${mod.limite != null ? `Limite da modalidade: ${pedidos(mod.limite)}.` : 'Limite da modalidade ainda não definido pelo Administrador.'}
        </p>

        <h3 style="font-size:1rem;margin-top:1rem">Itens do pedido</h3>
        ${disponiveis.length ? `
        <p class="muted small" style="margin-top:-.3rem">Marque os itens que vão compor o pedido (até ${MAX_ITENS_POR_SOLICITACAO} itens). Cada item marcado terá a mesma quantidade solicitada.</p>
        <div class="tabela-wrap itens-sol"><table>
          <thead><tr><th style="width:2.5rem"></th><th>Item</th><th>Unidade</th></tr></thead>
          <tbody>${disponiveis.map(i => {
            const semEstoque = !(i.saldo > 0);
            return `<tr class="${semEstoque ? 'linha-inativa' : ''}">
              <td><input type="checkbox" data-item="${i.id}" ${marcado(i.id) ? 'checked' : ''} ${semEstoque ? 'disabled' : ''} aria-label="${esc(i.nome)}" style="width:1.1rem;height:1.1rem;margin:0"></td>
              <td>${esc(i.nome)}${semEstoque ? ' <span class="status inativo">Sem estoque</span>' : ''}</td>
              <td>${esc(i.unidade)}</td>
            </tr>`;
          }).join('')}</tbody></table></div>` : '<p class="muted">Nenhum item disponível no momento.</p>'}

        <div class="erro" id="erroSol" style="margin-top:1rem"></div>
        <div class="acoes">
          <button class="btn primario" type="submit">Continuar</button>
          <button class="btn secundario" type="button" id="btnTrocarData">Escolher outra data</button>
        </div>
      </form>`;

    $('btnTrocarData').onclick = () => { dataSelecionada = null; sec.hidden = true; desenharCalendario(mod); };
    $('fSol').onsubmit = e => {
      e.preventDefault();
      const erro = msg => { $('erroSol').textContent = msg; };
      const quantidade = paraInteiro($('inpQtd').value);
      if (dados.solicitacoes.some(s => dataDe(s) === valores.data)) return erro(MSG_DUPLICADA);
      if (quantidade == null || Number.isNaN(quantidade) || quantidade < 1) return erro('Informe uma quantidade válida (número inteiro maior que zero).');
      const itemIds = [...document.querySelectorAll('[data-item]:checked')].map(c => c.dataset.item);
      const d = { data: valores.data, quantidade, itemIds };
      const { erros, itens } = validarSolicitacao(mod, d, dados.itens);
      if (erros.length) return erro(erros.join('\n'));
      d.itens = itens;
      resumoSolicitacao(mod, d);
    };
  }

  function resumoSolicitacao(mod, d) {
    // Identificador fixo "modalidade_data": só pode existir uma solicitação por
    // data para cada modalidade. Uma segunda gravação (ou uma confirmação repetida)
    // é recusada pelo Firestore.
    const solRef = doc(db, 'solicitacoes', `${mod.id}_${d.data}`);
    $('secSolicitacao').innerHTML = `
      <h2>Resumo da solicitação</h2>
      <p class="muted">Confira os dados antes de confirmar.</p>
      <dl class="resumo">
        <dt>Modalidade</dt><dd>${esc(mod.nome)}</dd>
        <dt>Data da retirada</dt><dd>${esc(fmtDataSemana(d.data))}</dd>
        <dt>Horário de retirada</dt><dd>${RETIRADA_TEXTO}</dd>
        <dt>Quantidade</dt><dd>${fmtQtd(d.quantidade)}</dd>
        <dt>Itens</dt><dd>${d.itens.map(i => `${esc(i.nome)}: ${esc(qtdUn(i.quantidade, i.unidade))}`).join('<br>')}</dd>
      </dl>
      <div class="erro" id="erroConf"></div>
      <div class="acoes">
        <button class="btn primario" id="btnConfirmar">Confirmar Solicitação</button>
        <button class="btn secundario" id="btnVoltar">Voltar</button>
      </div>`;
    $('btnVoltar').onclick = () => formularioSolicitacao(mod, d);
    $('btnConfirmar').onclick = () => comBotao($('btnConfirmar'), async () => {
      const erro = msg => { $('erroConf').textContent = msg; };
      // Prazo conferido de novo no momento da confirmação.
      if (situacaoData(d.data) !== 'aberta') return erro(situacaoData(d.data) === 'passada' ? MSG_DATA_PASSADA : msgPrazoEncerrado(d.data));
      try {
        if ((await getDoc(solRef)).exists()) return erro(MSG_DUPLICADA);
      } catch (e) { return erro(msgErro(e)); }
      try {
        // Confere limite e estoque com os dados mais recentes.
        const [mSnap, ...snaps] = await Promise.all([
          getDoc(doc(db, 'modalidades', mod.id)),
          ...d.itemIds.map(id => getDoc(doc(db, 'itens', id)))
        ]);
        const modAtual = { id: mSnap.id, ...mSnap.data() };
        const catalogo = snaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));
        const { erros, itens } = validarSolicitacao(modAtual, d, catalogo);
        if (erros.length) return erro(erros.join('\n'));

        const itensMap = {};
        itens.forEach(i => { itensMap[i.id] = { nome: i.nome, unidade: i.unidade, quantidade: i.quantidade }; });

        // A solicitação não mexe no estoque: a baixa é feita no "Fornecido".
        await setDoc(solRef, {
          modalidadeId: mod.id,
          data: d.data,
          horarioRetirada: HORARIO_RETIRADA,
          quantidade: d.quantidade,
          itens: itensMap,
          usuarioId: perfil.uid,
          usuarioNome: perfil.nome,
          status: 'pendente',
          baixaNoFornecimento: true,
          criadoEm: serverTimestamp()
        });
        telaResponsavel('Solicitação registrada com sucesso.');
      } catch (e) {
        // A solicitação não existia antes desta confirmação: se agora existe,
        // a gravação chegou ao servidor e só a resposta se perdeu.
        try {
          const ja = await getDoc(solRef);
          if (ja.exists()) return telaResponsavel('Solicitação registrada com sucesso.');
        } catch (_) { /* não existe ou sem acesso */ }
        if (e.code === 'permission-denied' && situacaoData(d.data) !== 'aberta') return erro(msgPrazoEncerrado(d.data));
        erro(e.code === 'permission-denied'
          ? 'Não foi possível registrar: o prazo, o estoque ou os limites foram alterados. Volte e revise a solicitação.'
          : msgErro(e));
      }
    });
  }

  /* ================= Administrador ================= */
  const ABAS = [
    ['solicitacoes', 'Solicitações'],
    ['itens', 'Itens e estoque'],
    ['modalidades', 'Modalidades e limites'],
    ['responsaveis', 'Responsáveis'],
    ['paioleiros', 'Paioleiros']
  ];

  async function garantirModalidades() {
    const atuais = await lista('modalidades');
    if (atuais.length) return ordenarModalidades(atuais);
    const b = writeBatch(db);
    MODALIDADES_INICIAIS.forEach((nome, i) =>
      b.set(doc(db, 'modalidades', 'm' + String(i + 1).padStart(2, '0')), { nome, limite: null, ordem: i + 1 }));
    await b.commit();
    return ordenarModalidades(await lista('modalidades'));
  }

  // Os dados são carregados ao entrar, ao clicar em "Atualizar" e após cada gravação.
  async function telaAdmin(aba, mensagem, recarregar) {
    if (recarregar) {
      app.innerHTML = CARREGANDO;
      try {
        const [modalidades, eventos, usuarios, solicitacoes, itens, movimentos, exclusoes] = await Promise.all([
          garantirModalidades(), lista('eventos').catch(() => []), lista('usuarios'), lista('solicitacoes'), lista('itens'), lista('movimentos'),
          lista('exclusoes').catch(() => [])
        ]);
        dados = { modalidades, eventos, usuarios, solicitacoes, itens, movimentos, exclusoes };
      } catch (e) {
        return telaFalha('Administrador', e, () => telaAdmin(aba, '', true));
      }
    }
    app.innerHTML = cabecalho('Administrador', true) + `
      <nav class="abas">${ABAS.map(([k, t]) => `<button data-aba="${k}" class="${k === aba ? 'ativa' : ''}">${t}</button>`).join('')}</nav>
      <main class="conteudo">
        ${mensagem ? `<div class="aviso">${esc(mensagem)}</div>` : ''}
        <div id="painel"></div>
      </main>`;
    ligarSair();
    $('btnAtualizar').onclick = () => telaAdmin(aba, '', true);
    document.querySelectorAll('.abas button').forEach(b => b.onclick = () => telaAdmin(b.dataset.aba));
    PAINEIS[aba]($('painel'));
  }
  const salvo = (aba, msg) => telaAdmin(aba, msg, true);

  // Cria o login (Firebase Authentication) em uma instância separada,
  // para não desconectar o Administrador. Devolve o UID do novo usuário.
  async function criarAcesso(email, senha) {
    const appCadastro = initializeApp(cfg, 'cadastro-' + Date.now());
    try {
      const authCadastro = initializeAuth(appCadastro, { persistence: inMemoryPersistence });
      const cred = await createUserWithEmailAndPassword(authCadastro, email, senha);
      await signOut(authCadastro);
      return cred.user.uid;
    } finally {
      await deleteApp(appCadastro);
    }
  }

  /* ================= Exclusão de usuários (somente Administrador) ================= */
  // Exclui o cadastro do usuário (coleção "usuarios") e registra a exclusão em "exclusoes",
  // na mesma gravação. Sem o cadastro, o Firebase bloqueia todo o acesso aos dados
  // (regras do Firestore) e o sistema não permite entrar. Solicitações, fornecimentos,
  // registros de alteração e movimentações NÃO são apagados e mantêm o nome do usuário.
  // O login no Firebase Authentication é removido pelo Administrador no Console
  // (no plano gratuito, o navegador não pode apagar o login de outra pessoa).
  const nomePerfil = u => u.perfil === 'responsavel' ? 'Responsável' : ehPerfilPaioleiro(u) ? 'Paioleiro' : 'Administrador';
  const botaoExcluir = u => `<button class="btn perigo pequeno" data-excluir="${u.id}">Excluir</button>`;

  function ligarExclusao(p, aba) {
    p.querySelectorAll('[data-excluir]').forEach(b => b.onclick = () => {
      const u = dados.usuarios.find(x => x.id === b.dataset.excluir);
      if (!u) return;
      $('secExcluir')?.remove();
      const bloqueio = u.id === perfil.uid ? 'Você não pode excluir a própria conta.'
        : u.perfil === 'admin' ? 'Contas de Administrador não podem ser excluídas pelo sistema.' : '';
      p.insertAdjacentHTML('afterbegin', `
      <section class="card exclusao" id="secExcluir">
        <h2>Excluir usuário</h2>
        <dl class="resumo">
          <dt>Nome</dt><dd>${esc(u.nome)}</dd>
          <dt>Login</dt><dd>${esc(u.email || '—')}</dd>
          <dt>Perfil</dt><dd>${esc(nomePerfil(u))}</dd>
          ${u.perfil === 'responsavel' ? `<dt>Modalidade</dt><dd>${esc(modalidade(u.modalidadeId)?.nome ?? '—')}</dd>` : ''}
        </dl>
        <p class="small">O cadastro será <strong>excluído</strong> e o acesso ao sistema ficará <strong>bloqueado imediatamente</strong>.
          Solicitações, fornecimentos, registros de alteração de quantidade e movimentações de estoque <strong>não serão apagados</strong>
          e continuarão identificando este usuário pelo nome.</p>
        <div class="erro" id="erroExcluir">${esc(bloqueio)}</div>
        <div class="acoes">
          <button class="btn secundario" id="btnCancelarExcluir">Cancelar</button>
          <button class="btn perigo-cheio" id="btnConfirmarExcluir" ${bloqueio ? 'disabled' : ''}>Confirmar exclusão</button>
        </div>
      </section>`);
      $('secExcluir').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      $('btnCancelarExcluir').onclick = () => $('secExcluir').remove();
      $('btnConfirmarExcluir').onclick = () => comBotao($('btnConfirmarExcluir'), async () => {
        try {
          const lote = writeBatch(db);
          lote.delete(doc(db, 'usuarios', u.id));
          lote.set(doc(db, 'exclusoes', u.id), {
            nome: u.nome, email: u.email || '', perfil: u.perfil, modalidadeId: u.modalidadeId || null,
            excluidoEm: serverTimestamp(), porUid: perfil.uid, porNome: perfil.nome
          });
          await lote.commit();
          salvo(aba, `Usuário ${u.nome} (${nomePerfil(u)}) excluído. O acesso ao sistema foi bloqueado. ` +
            `Para concluir, remova o login ${u.email} em Firebase → Authentication → Usuários.`);
        } catch (err) {
          $('erroExcluir').textContent = 'Não foi possível excluir: ' + msgErro(err) + ' Nada foi alterado; tente novamente.';
        }
      });
    });
  }

  function historicoExclusoesHtml(filtro) {
    const l = (dados.exclusoes || []).filter(filtro).sort((a, b) => ms(b.excluidoEm) - ms(a.excluidoEm));
    if (!l.length) return '';
    return `<section class="card">
      <h2>Usuários excluídos</h2>
      <p class="muted small" style="margin-top:-.3rem">Histórico para auditoria. Se ainda não fez, remova o login de cada um em Firebase → Authentication → Usuários.</p>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Excluído em</th><th>Por</th></tr></thead>
        <tbody>${l.map(x => `<tr class="linha-inativa">
          <td>${esc(x.nome)}</td><td>${esc(x.email)}</td><td>${esc(nomePerfil(x))}${x.modalidadeId ? ' · ' + esc(modalidade(x.modalidadeId)?.nome ?? '') : ''}</td>
          <td>${fmtDataHora(x.excluidoEm)}</td><td>${esc(x.porNome || '—')}</td>
        </tr>`).join('')}</tbody></table></div>
    </section>`;
  }

  /* ================= Paioleiro ================= */
  // Vê apenas solicitações autorizadas ("Pedido Recebido") e as já fornecidas,
  // e só pode marcar "Fornecido" (com baixa no estoque).
  async function telaPaioleiro(mensagem) {
    app.innerHTML = CARREGANDO;
    try {
      const [modalidades, eventos, solicitacoes] = await Promise.all([
        lista('modalidades'), lista('eventos').catch(() => []),
        listaConsulta(query(collection(db, 'solicitacoes'), where('status', 'in', ['recebido', 'fornecido'])))
      ]);
      dados = { ...vazio(), modalidades: ordenarModalidades(modalidades), eventos, solicitacoes };
    } catch (e) {
      return telaFalha('Paioleiro', e, () => telaPaioleiro());
    }
    app.innerHTML = cabecalho('Paioleiro', true) + `
      <main class="conteudo">
        ${mensagem ? `<div class="aviso">${esc(mensagem)}</div>` : ''}
        <div id="painel"></div>
      </main>`;
    ligarSair();
    $('btnAtualizar').onclick = () => telaPaioleiro();
    PAINEIS.solicitacoes($('painel'));
  }

  const botaoSalvar = (ed, id) => `<button class="btn primario" type="submit" id="${id}">${ed ? 'Salvar alterações' : 'Cadastrar'}</button>`;
  const botaoCancelar = ed => ed ? '<button class="btn secundario" type="button" id="btnCancelar">Cancelar edição</button>' : '';

  const PAINEIS = {
    /* ---- Solicitações ---- */
    solicitacoes(p) {
      const paioleiro = ctxSol.papel === 'paioleiro';
      const hoje = hojeISO();
      const todas = dados.solicitacoes.slice();
      const grupo = (g, l = todas) => l.filter(s => grupoDe(s) === g);
      const soma = l => l.reduce((t, s) => t + (s.quantidade || 0), 0);
      // Datas que possuem solicitações: próximas primeiro (da mais próxima para a mais distante), depois as passadas.
      const ordemDatas = (x, y) => {
        const fx = x >= hoje, fy = y >= hoje;
        if (fx !== fy) return fx ? -1 : 1;
        return fx ? x.localeCompare(y) : y.localeCompare(x);
      };
      const datas = [...new Set(todas.map(dataDe))].sort(ordemDatas);
      if (filtroData && filtroData !== 'todas' && !datas.includes(filtroData) && filtroData !== hoje) filtroData = 'todas';
      const naData = filtroData && filtroData !== 'todas' ? todas.filter(s => dataDe(s) === filtroData) : todas;
      const pend = grupo('pendentes', naData), rec = grupo('recebidos', naData), forn = grupo('fornecidos', naData);
      const visiveis = filtroSolicitacoes === 'todas' ? naData : grupo(filtroSolicitacoes, naData);
      const indicador = (rotulo, l, destaque) => `<div class="indicador ${destaque ? 'destaque' : ''}">
        <div class="rotulo">${rotulo}</div><div class="valor">${fmtQtd(soma(l))}</div>
        <div class="small ${destaque ? '' : 'muted'}" ${destaque ? 'style="color:var(--azul-200)"' : ''}>${plural(l.length, 'solicitação', 'solicitações')}</div></div>`;

      const acoes = s => {
        const st = statusDe(s);
        if (st === 'pendente' && !paioleiro)
          return `<div style="margin-top:.35rem"><button class="btn primario pequeno" data-receber="${s.id}">Pedido Recebido</button></div>`;
        if (st === 'recebido')
          return `<div style="margin-top:.35rem"><button class="btn primario pequeno" data-fornecer="${s.id}">✓ Fornecido</button></div>`;
        if (st === 'fornecido')
          return `<div style="margin-top:.35rem"><button class="btn secundario pequeno" disabled title="Esta solicitação já foi fornecida">✓ Fornecido</button></div>`;
        return '';
      };

      // Itens a preparar na data: soma dos itens das solicitações ainda não fornecidas.
      function itensAPreparar(l) {
        const tot = {};
        l.filter(s => grupoDe(s) !== 'fornecidos').forEach(s => itensDaSolicitacao(s).forEach(i => {
          tot[i.nome] = tot[i.nome] || { q: 0, un: i.unidade };
          tot[i.nome].q += i.quantidade;
        }));
        const e = Object.entries(tot).sort((x, y) => x[0].localeCompare(y[0]));
        return e.length ? e.map(([n, v]) => `${esc(n)}: <strong>${esc(qtdUn(v.q, v.un))}</strong>`).join(' · ') : 'tudo fornecido';
      }

      const porData = [...new Set(visiveis.map(dataDe))].sort(ordemDatas).map(dt => ({
        dt, lista: visiveis.filter(s => dataDe(s) === dt).sort((x, y) => (modalidade(x.modalidadeId)?.nome || '').localeCompare(modalidade(y.modalidadeId)?.nome || ''))
      }));

      p.innerHTML = `
      <div class="indicadores">
        ${paioleiro
          ? indicador('Pedidos a fornecer', rec, true) + indicador('Pedidos fornecidos', forn)
          : indicador('Pedidos pendentes', pend, true) + indicador('Pedidos recebidos', rec) + indicador('Pedidos fornecidos', forn) + indicador('Total de pedidos', naData)}
      </div>
      <section class="card">
        <h2>${paioleiro ? 'Solicitações autorizadas' : 'Solicitações por data'}</h2>
        <p class="muted small" style="margin-top:-.3rem">${paioleiro
          ? 'Aqui aparecem as solicitações autorizadas pelo Administrador ("Pedido Recebido"). Ao entregar o pedido, clique em "Fornecido": a baixa no estoque é feita nesse momento.'
          : 'Fluxo: Pendente → Pedido Recebido → Fornecido. A baixa no estoque ocorre somente no "Fornecido".'} Retirada sempre das ${RETIRADA_TEXTO}.</p>
        <div class="filtro-data">
          <label>Data da retirada
            <select id="selData">
              <option value="todas" ${!filtroData || filtroData === 'todas' ? 'selected' : ''}>Todas as datas</option>
              ${(datas.includes(hoje) ? datas : [hoje, ...datas]).map(dt => {
                const n = todas.filter(s => dataDe(s) === dt).length;
                return `<option value="${dt}" ${filtroData === dt ? 'selected' : ''}>${esc(fmtDataSemana(dt))}${dt === hoje ? ' — hoje' : ''} · ${plural(n, 'solicitação', 'solicitações')}</option>`;
              }).join('')}
            </select>
          </label>
          <button type="button" class="btn secundario pequeno" id="btnHoje">Hoje</button>
        </div>
        <div class="filtros">
          ${(paioleiro
            ? [['recebidos', 'A fornecer'], ['fornecidos', 'Fornecidos'], ['todas', 'Todas']]
            : [['todas', 'Todas'], ['pendentes', 'Pendentes'], ['recebidos', 'Pedido Recebido'], ['fornecidos', 'Fornecidos']]).map(([k, t]) =>
            `<button data-filtro="${k}" class="${filtroSolicitacoes === k ? 'ativo' : ''}">${t}</button>`).join('')}
        </div>
        <div class="erro" id="erroAtend"></div>
        ${porData.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Modalidade</th><th class="num">Quantidade</th><th>Itens</th><th>Responsável</th><th>Registrada em</th><th>Status</th></tr></thead>
          <tbody>${porData.map(({ dt, lista }) => `
            <tr class="grupo-data"><td colspan="6">
              <div class="grupo-titulo">📅 ${esc(fmtDataSemana(dt))}${dt === hoje ? ' <span class="status recebido">hoje</span>' : ''}
                <span class="grupo-info">Retirada ${RETIRADA_TEXTO} · ${plural(lista.length, 'solicitação', 'solicitações')} · Quantidade total: ${fmtQtd(soma(lista))}</span></div>
              <div class="grupo-itens">Itens a preparar: ${itensAPreparar(lista)}</div>
            </td></tr>
            ${lista.map(s => `<tr class="${classeLinha(s)}">
              <td><strong>${esc(modalidade(s.modalidadeId)?.nome ?? '—')}</strong></td>
              <td class="num">${fmtQtd(s.quantidade)}</td>
              <td>${listaItensHtml(s)}</td>
              <td>${esc(s.usuarioNome || '—')}</td>
              <td>${fmtDataHora(s.criadoEm)}</td>
              <td>${seloStatus(s)}${historicoStatus(s)}${acoes(s)}</td>
            </tr>${temAlteracoes(s) ? `<tr class="linha-registro"><td colspan="6">
              <div class="registro-titulo">Registro de Alterações na Quantidade</div>
              ${tabelaRegistro(s.alteracoes, s.fornecidoPorNome, fmtDataHora(s.fornecidoEm))}
            </td></tr>` : ''}`).join('')}`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma solicitação neste filtro.</p>'}
      </section>`;

      const erro = msg => { $('erroAtend').textContent = msg; };
      const resumoTexto = s =>
        `Modalidade: ${modalidade(s.modalidadeId)?.nome ?? '—'}\n` +
        `Data da retirada: ${fmtDataSemana(dataDe(s))}\n` +
        `Retirada: ${textoRetirada(s)}\n` +
        `Quantidade: ${fmtQtd(s.quantidade)}`;

      $('selData').onchange = () => { filtroData = $('selData').value; PAINEIS.solicitacoes(p); };
      $('btnHoje').onclick = () => { filtroData = hoje; PAINEIS.solicitacoes(p); };

      p.querySelectorAll('[data-filtro]').forEach(b => b.onclick = () => { filtroSolicitacoes = b.dataset.filtro; PAINEIS.solicitacoes(p); });

      // ---- Pedido Recebido (não altera o estoque) ----
      p.querySelectorAll('[data-receber]').forEach(b => b.onclick = () => {
        const s = dados.solicitacoes.find(x => x.id === b.dataset.receber);
        if (!window.confirm(`Confirmar que este pedido foi recebido e registrado para atendimento?\n\n${resumoTexto(s)}\n\nO estoque não será alterado.`)) return;
        comBotao(b, async () => {
          try {
            await updateDoc(doc(db, 'solicitacoes', s.id), {
              status: 'recebido',
              recebidoEm: serverTimestamp(),
              recebidoPorUid: perfil.uid,
              recebidoPorNome: perfil.nome
            });
            ctxSol.recarregar('Solicitação marcada como Pedido Recebido.');
          } catch (err) {
            erro(err.code === 'permission-denied'
              ? 'Não foi possível marcar como Pedido Recebido: o status desta solicitação já foi alterado. Clique em Atualizar.'
              : msgErro(err));
          }
        });
      });

      // ---- Fornecido (tela de fornecimento; baixa no estoque, uma única vez) ----
      p.querySelectorAll('[data-fornecer]').forEach(b => b.onclick = () => {
        const s = dados.solicitacoes.find(x => x.id === b.dataset.fornecer);
        abrirFornecimento(s);
      });

      function abrirFornecimento(s) {
        $('secFornec')?.remove();
        const comBaixa = baixaNoFornecimento(s);
        const lista = itensDaSolicitacao(s);
        p.insertAdjacentHTML('afterbegin', `
        <section class="card fornecimento" id="secFornec">
          <h2>Fornecimento</h2>
          <dl class="resumo">
            <dt>Modalidade</dt><dd>${esc(modalidade(s.modalidadeId)?.nome ?? '—')}</dd>
            <dt>Data da retirada</dt><dd>${esc(fmtDataSemana(dataDe(s)))}</dd>
            <dt>Retirada</dt><dd>${esc(textoRetirada(s))}</dd>
            <dt>Responsável</dt><dd>${esc(s.usuarioNome || '—')}</dd>
            <dt>Quantidade aprovada</dt><dd>${fmtQtd(s.quantidade)}</dd>
          </dl>
          ${comBaixa ? `
          <p class="muted small">Confira cada item. Você pode <strong>manter ou reduzir</strong> a quantidade fornecida, mas não pode ultrapassar a quantidade aprovada pelo Administrador. A baixa no estoque considera a quantidade fornecida.</p>
          <div class="tabela-wrap"><table>
            <thead><tr><th>Item</th><th class="num">Aprovado</th><th class="num">Fornecido</th><th>Justificativa da redução (opcional)</th></tr></thead>
            <tbody>${lista.map(i => `<tr>
              <td><strong>${esc(i.nome)}</strong></td>
              <td class="num">${esc(qtdUn(i.quantidade, i.unidade))}</td>
              <td class="num"><input type="number" min="0" max="${i.quantidade}" step="1" inputmode="numeric" data-forn="${i.id}" value="${i.quantidade}" aria-label="Quantidade fornecida de ${esc(i.nome)}" style="max-width:110px;margin-left:auto"></td>
              <td><input data-just="${i.id}" maxlength="300" placeholder="Motivo da redução" aria-label="Justificativa para ${esc(i.nome)}"></td>
            </tr>`).join('')}</tbody></table></div>
          <h3 style="font-size:1rem;margin-top:1.1rem">Registro de Alterações na Quantidade</h3>
          <div id="previaRegistro"></div>` : `
          <p class="muted small">Esta solicitação é anterior ao fornecimento com ajuste de quantidade: o estoque já foi baixado na época e não será baixado novamente.</p>`}
          <div class="erro" id="erroFornec" style="margin-top:.8rem"></div>
          <div class="acoes">
            <button class="btn primario" id="btnConfirmarFornec">Confirmar fornecimento</button>
            <button class="btn secundario" id="btnCancelarFornec">Cancelar</button>
          </div>
        </section>`);
        $('secFornec').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        const erroF = msg => { $('erroFornec').textContent = msg; };
        $('btnCancelarFornec').onclick = () => $('secFornec').remove();

        // Lê os valores informados e monta o registro (somente itens reduzidos).
        function lerFornecimento() {
          const fornecidos = {}, alteracoes = {}, erros = [];
          for (const i of lista) {
            const f = paraInteiro(document.querySelector(`[data-forn="${i.id}"]`).value);
            const just = document.querySelector(`[data-just="${i.id}"]`).value.trim().slice(0, 300);
            if (f == null || Number.isNaN(f) || f < 0) { erros.push(`${i.nome}: informe a quantidade fornecida (número inteiro, zero ou mais).`); continue; }
            if (f > i.quantidade) { erros.push(`${i.nome}: a quantidade fornecida (${qtdUn(f, i.unidade)}) não pode ser maior que a aprovada (${qtdUn(i.quantidade, i.unidade)}).`); continue; }
            fornecidos[i.id] = f;
            if (f < i.quantidade)
              alteracoes[i.id] = { nome: i.nome, unidade: i.unidade, aprovada: i.quantidade, fornecida: f, diferenca: i.quantidade - f, justificativa: just };
          }
          if (!erros.length && Object.values(fornecidos).every(f => f === 0))
            erros.push('Informe ao menos um item com quantidade fornecida maior que zero.');
          return { fornecidos, alteracoes, erros };
        }
        function atualizarPrevia() {
          const { alteracoes } = lerFornecimento();
          $('previaRegistro').innerHTML = tabelaRegistro(alteracoes, perfil.nome, 'no momento da confirmação');
        }
        if (comBaixa) {
          document.querySelectorAll('#secFornec [data-forn], #secFornec [data-just]').forEach(inp => inp.oninput = atualizarPrevia);
          atualizarPrevia();
        }

        $('btnConfirmarFornec').onclick = () => {
          const leitura = comBaixa ? lerFornecimento() : { fornecidos: {}, alteracoes: {}, erros: [] };
          if (leitura.erros.length) return erroF(leitura.erros.join('\n'));
          const linhas = lista.map(i => {
            const f = leitura.fornecidos[i.id];
            return `• ${i.nome}: fornecido ${qtdUn(f, i.unidade)}${f < i.quantidade ? ` (aprovado ${qtdUn(i.quantidade, i.unidade)}; redução de ${qtdUn(i.quantidade - f, i.unidade)})` : ''}`;
          }).join('\n');
          const texto = `Confirmar que este pedido foi FORNECIDO ao responsável?\n\n${resumoTexto(s)}\n\n` +
            (comBaixa ? `Serão descontados do estoque:\n${linhas}\n\nEsta ação não pode ser desfeita.`
                      : 'O estoque já foi baixado anteriormente e não será baixado novamente.');
          if (!window.confirm(texto)) return;
          fornecer(s, leitura);
        };

        function fornecer(s, leitura) {
          const btn = $('btnConfirmarFornec');
          comBotao(btn, async () => {
            const solRef = doc(db, 'solicitacoes', s.id);
            try {
              // Confere o status atual no servidor (evita baixa duplicada após atualização da página).
              const atualSnap = await getDoc(solRef);
              const atual = { id: atualSnap.id, ...atualSnap.data() };
              if (statusDe(atual) === 'fornecido') return ctxSol.recarregar('Esta solicitação já estava marcada como Fornecido. Nenhuma nova baixa foi feita.');
              if (statusDe(atual) !== 'recebido') return erroF('Esta solicitação precisa estar como "Pedido Recebido" antes de ser marcada como Fornecido.');

              const lote = writeBatch(db);
              const dadosFornec = {
                status: 'fornecido',
                fornecidoEm: serverTimestamp(),
                fornecidoPorUid: perfil.uid,
                fornecidoPorNome: perfil.nome
              };
              if (baixaNoFornecimento(atual)) {
                const itensAtuais = itensDaSolicitacao(atual);
                const snaps = await Promise.all(itensAtuais.map(i => getDoc(doc(db, 'itens', i.id))));
                const faltas = [];
                itensAtuais.forEach((i, k) => {
                  const f = leitura.fornecidos[i.id];
                  const it = snaps[k].exists() ? snaps[k].data() : null;
                  if (f == null || f > i.quantidade) faltas.push(`${i.nome}: quantidade fornecida inválida.`);
                  else if (!it) faltas.push(`${i.nome}: item não encontrado no cadastro.`);
                  else if (it.saldo < f)
                    faltas.push(`${i.nome}: estoque insuficiente (necessário ${qtdUn(f, i.unidade)}; disponível ${qtdUn(Math.max(it.saldo, 0), it.unidade)}).`);
                });
                if (faltas.length) return erroF('Não foi possível marcar como Fornecido:\n' + faltas.join('\n') + '\nAjuste a quantidade fornecida ou registre uma entrada no estoque.');
                // A quantidade aprovada (campo "itens") não é alterada: o fornecido fica em campos próprios.
                dadosFornec.fornecidos = leitura.fornecidos;
                dadosFornec.alteracoes = leitura.alteracoes;
                itensAtuais.forEach(i => lote.update(doc(db, 'itens', i.id), {
                  saldo: increment(-leitura.fornecidos[i.id]),
                  saidas: increment(leitura.fornecidos[i.id]),
                  ultimaBaixa: s.id,
                  ultimaBaixaEm: serverTimestamp()
                }));
              }
              lote.update(solRef, dadosFornec);
              await lote.commit();
              ctxSol.recarregar(baixaNoFornecimento(atual)
                ? 'Solicitação marcada como Fornecido e baixa realizada no estoque pela quantidade fornecida.'
                : 'Solicitação marcada como Fornecido.');
            } catch (err) {
              // Se a gravação chegou ao servidor e só a resposta se perdeu, não repete.
              try {
                const depois = await getDoc(solRef);
                if (depois.exists() && depois.data().status === 'fornecido')
                  return ctxSol.recarregar('Solicitação marcada como Fornecido.');
              } catch (_) { /* sem acesso ou sem conexão */ }
              erroF(err.code === 'permission-denied'
                ? 'Não foi possível marcar como Fornecido: o estoque ou o status foi alterado. Clique em Atualizar e tente novamente.'
                : msgErro(err));
            }
          });
        }
      }
    },

    /* ---- Itens e estoque ---- */
    itens(p, editId) {
      const ed = editId ? item(editId) : null;
      const temMovimento = ed && (ed.entradas > 0 || ed.saidas > 0);
      const l = itensOrdenados();

      // Movimentações: estoque inicial e entradas (registradas pelo Administrador)
      // e saídas (registradas em cada solicitação).
      const movs = [
        ...dados.movimentos.map(m => ({
          quando: m.criadoEm, itemNome: m.itemNome, tipo: m.tipo === 'inicial' ? 'Estoque inicial' : 'Entrada',
          quantidade: m.quantidade, unidade: item(m.itemId)?.unidade ?? '', origem: m.porNome || '—', saida: false
        })),
        ...dados.solicitacoes.filter(estoqueBaixado).flatMap(s => itensDaSolicitacao(s).map(i => ({
          quando: dataDaBaixa(s), itemNome: i.nome, tipo: 'Saída', quantidade: qtdFornecida(s, i), unidade: i.unidade,
          origem: `Fornecido · ${modalidade(s.modalidadeId)?.nome ?? '—'}${s.fornecidoPorNome ? ' · por ' + s.fornecidoPorNome : ''}` +
            (qtdFornecida(s, i) !== i.quantidade ? ` · aprovado ${qtdUn(i.quantidade, i.unidade)}, reduzido em ${qtdUn(i.quantidade - qtdFornecida(s, i), i.unidade)}` : ''),
          saida: true
        })).filter(m => m.quantidade > 0))
      ].sort((a, b) => ms(b.quando) - ms(a.quando));

      p.innerHTML = `
      <section class="card">
        <h2>${ed ? 'Editar item' : 'Cadastrar item'}</h2>
        <form id="fItem" novalidate>
          <div class="grade">
            <label>Nome do item<input name="nome" value="${esc(ed?.nome)}"></label>
            <label>Unidade de medida<input name="unidade" list="listaUnidades" value="${esc(ed?.unidade)}" placeholder="un, pct, kg…"></label>
            <label>Estoque inicial<input type="number" min="0" step="1" inputmode="numeric" name="inicial" value="${editavel(ed?.estoqueInicial)}" ${temMovimento ? 'readonly' : ''}></label>
          </div>
          <datalist id="listaUnidades">${UNIDADES.map(u => `<option value="${u}">`).join('')}</datalist>
          <p class="muted small" style="margin-top:-.4rem">Use números inteiros. Em cada solicitação, o item é descontado pela quantidade efetivamente fornecida.${temMovimento ? ' Este item já tem movimentações; para aumentar o estoque, registre uma entrada.' : ''}</p>
          <div class="erro" id="erroItem"></div>
          <div class="acoes">${botaoSalvar(ed, 'btnItem')}${botaoCancelar(ed)}</div>
        </form>
      </section>

      ${l.length ? `
      <section class="card">
        <h2>Registrar entrada no estoque</h2>
        <form id="fEntrada" novalidate>
          <div class="grade">
            <label>Item
              <select name="item">
                <option value="">Selecione</option>
                ${l.map(i => `<option value="${i.id}">${esc(i.nome)} (saldo: ${esc(qtdUn(i.saldo, i.unidade))})</option>`).join('')}
              </select>
            </label>
            <label>Quantidade de entrada<input type="number" min="1" step="1" inputmode="numeric" name="qtd"></label>
          </div>
          <div class="erro" id="erroEntrada"></div>
          <button class="btn primario" type="submit" id="btnEntrada">Registrar entrada</button>
        </form>
      </section>` : ''}

      <section class="card">
        <h2>Itens cadastrados e estoque atual</h2>
        <div class="erro" id="erroLista"></div>
        ${l.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Item</th><th>Unidade</th><th class="num">Estoque inicial</th><th class="num">Entradas</th><th class="num">Saídas</th><th class="num">Saldo</th><th>Situação</th><th></th></tr></thead>
          <tbody>${l.map(i => `<tr class="${i.ativo ? '' : 'linha-inativa'}">
            <td><strong>${esc(i.nome)}</strong></td><td>${esc(i.unidade)}</td>
            <td class="num">${fmtQtd(i.estoqueInicial)}</td>
            <td class="num">${fmtQtd(i.entradas)}</td>
            <td class="num">${fmtQtd(i.saidas)}</td>
            <td class="num"><strong>${fmtQtd(i.saldo)}</strong></td>
            <td>${i.ativo ? '<span class="status ativo">Ativo</span>' : '<span class="status inativo">Inativo</span>'}</td>
            <td class="num" style="white-space:nowrap">
              <button class="btn secundario pequeno" data-edit="${i.id}">Editar</button>
              <button class="btn secundario pequeno" data-ativo="${i.id}">${i.ativo ? 'Desativar' : 'Ativar'}</button>
            </td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum item cadastrado.</p>'}
      </section>

      <section class="card">
        <h2>Movimentações de estoque</h2>
        ${movs.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Data</th><th>Item</th><th>Tipo</th><th class="num">Quantidade</th><th>Origem</th></tr></thead>
          <tbody>${movs.map(m => `<tr>
            <td>${fmtDataHora(m.quando)}</td><td>${esc(m.itemNome)}</td><td>${m.tipo}</td>
            <td class="num">${m.saida ? '−' : '+'}${esc(qtdUn(m.quantidade, m.unidade))}</td><td>${esc(m.origem)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma movimentação registrada.</p>'}
      </section>`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.itens(p, b.dataset.edit));
      if (ed) $('btnCancelar').onclick = () => PAINEIS.itens(p);

      p.querySelectorAll('[data-ativo]').forEach(b => b.onclick = () => comBotao(b, async () => {
        const i = item(b.dataset.ativo);
        try {
          await updateDoc(doc(db, 'itens', i.id), { ativo: !i.ativo });
          salvo('itens', `Item ${i.nome} ${i.ativo ? 'desativado' : 'ativado'}.`);
        } catch (err) { $('erroLista').textContent = msgErro(err); }
      }));

      $('fItem').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const erro = msg => { $('erroItem').textContent = msg; };
        const nome = String(f.get('nome')).trim();
        const unidade = String(f.get('unidade')).trim();
        const inicial = paraInteiro(f.get('inicial'));
        if (!nome) return erro('Informe o nome do item.');
        if (dados.itens.some(i => i.nome.toLowerCase() === nome.toLowerCase() && i.id !== ed?.id)) return erro('Já existe um item com este nome.');
        if (!unidade) return erro('Informe a unidade de medida.');
        if (inicial == null || Number.isNaN(inicial) || inicial < 0) return erro('Informe o estoque inicial (número inteiro, zero ou mais).');

        comBotao($('btnItem'), async () => {
          try {
            if (ed) {
              const alt = { nome, unidade };
              if (!temMovimento && inicial !== ed.estoqueInicial) { alt.estoqueInicial = inicial; alt.saldo = inicial; }
              await updateDoc(doc(db, 'itens', ed.id), alt);
              return salvo('itens', 'Item atualizado.');
            }
            const ref = doc(collection(db, 'itens'));
            const lote = writeBatch(db);
            lote.set(ref, {
              nome, unidade, ativo: true,
              estoqueInicial: inicial, entradas: 0, saidas: 0, saldo: inicial, ultimaBaixa: ''
            });
            lote.set(doc(collection(db, 'movimentos')), {
              itemId: ref.id, itemNome: nome, tipo: 'inicial', quantidade: inicial,
              criadoEm: serverTimestamp(), porUid: perfil.uid, porNome: perfil.nome
            });
            await lote.commit();
            salvo('itens', 'Item cadastrado.');
          } catch (err) { erro(msgErro(err)); }
        });
      };

      if (l.length) $('fEntrada').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const erro = msg => { $('erroEntrada').textContent = msg; };
        const i = item(String(f.get('item')));
        const q = paraInteiro(f.get('qtd'));
        if (!i) return erro('Selecione o item.');
        if (q == null || Number.isNaN(q) || q < 1) return erro('Informe uma quantidade de entrada válida (número inteiro maior que zero).');
        comBotao($('btnEntrada'), async () => {
          try {
            const lote = writeBatch(db);
            lote.update(doc(db, 'itens', i.id), { entradas: increment(q), saldo: increment(q) });
            lote.set(doc(collection(db, 'movimentos')), {
              itemId: i.id, itemNome: i.nome, tipo: 'entrada', quantidade: q,
              criadoEm: serverTimestamp(), porUid: perfil.uid, porNome: perfil.nome
            });
            await lote.commit();
            salvo('itens', `Entrada de ${qtdUn(q, i.unidade)} registrada para ${i.nome}.`);
          } catch (err) { erro(msgErro(err)); }
        });
      };
    },

    /* ---- Modalidades e limites ---- */
    modalidades(p) {
      p.innerHTML = `<section class="card">
        <h2>Modalidades e limite máximo de pedidos</h2>
        <form id="fMod" novalidate>
          <div class="tabela-wrap"><table>
            <thead><tr><th>#</th><th>Modalidade</th><th>Limite máximo de pedidos</th><th>Responsável</th></tr></thead>
            <tbody>${dados.modalidades.map((m, i) => {
              const resp = dados.usuarios.find(u => u.modalidadeId === m.id);
              return `<tr>
                <td>${i + 1}</td>
                <td><input name="nome_${m.id}" value="${esc(m.nome)}"></td>
                <td><input type="number" min="0" step="1" name="lim_${m.id}" value="${m.limite ?? ''}" placeholder="Não definido"></td>
                <td>${resp ? esc(resp.nome) : '<span class="muted">—</span>'}</td>
              </tr>`;
            }).join('')}</tbody></table></div>
          <div class="erro" id="erroMod" style="margin-top:.8rem"></div>
          <button class="btn primario" type="submit" id="btnMod">Salvar alterações</button>
        </form></section>`;

      $('fMod').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const erro = msg => { $('erroMod').textContent = msg; };
        const novos = [];
        for (const m of dados.modalidades) {
          const nome = String(f.get('nome_' + m.id)).trim();
          const limite = inteiro(f.get('lim_' + m.id));
          if (!nome) return erro('Todas as modalidades precisam de um nome.');
          if (Number.isNaN(limite) || (limite != null && limite < 0)) return erro(`Limite inválido para "${nome}".`);
          novos.push({ m, nome, limite });
        }
        const nomes = novos.map(n => n.nome.toLowerCase());
        if (new Set(nomes).size !== nomes.length) return erro('Existem modalidades com nomes repetidos.');
        const alterados = novos.filter(n => n.nome !== n.m.nome || n.limite !== (n.m.limite ?? null));
        if (!alterados.length) return erro('Nenhuma alteração para salvar.');
        comBotao($('btnMod'), async () => {
          try {
            const b = writeBatch(db);
            alterados.forEach(n => b.update(doc(db, 'modalidades', n.m.id), { nome: n.nome, limite: n.limite }));
            await b.commit();
            salvo('modalidades', 'Modalidades atualizadas.');
          } catch (err) { erro(msgErro(err)); }
        });
      };
    },

    /* ---- Paioleiros ---- */
    paioleiros(p, editId) {
      const lst = dados.usuarios.filter(ehPerfilPaioleiro).sort((a, b) => a.nome.localeCompare(b.nome));
      const ed = editId ? dados.usuarios.find(u => u.id === editId) : null;
      p.innerHTML = `
      <section class="card">
        <h2>${ed ? 'Editar paioleiro' : 'Cadastrar paioleiro'}</h2>
        <p class="muted small" style="margin-top:-.3rem">O paioleiro vê apenas as solicitações autorizadas ("Pedido Recebido") e só pode marcá-las como "Fornecido", podendo manter ou reduzir a quantidade de cada item. Não acessa itens, estoque, limites, eventos nem cadastros.</p>
        <form id="fCat" novalidate>
          <div class="grade">
            <label>Nome<input name="nome" value="${esc(ed?.nome)}"></label>
            <label>Usuário/e-mail<input type="email" name="email" value="${esc(ed?.email)}" autocomplete="off" ${ed ? 'readonly' : ''}></label>
            ${ed ? '' : '<label>Senha inicial<input type="password" name="senha" autocomplete="new-password" placeholder="Mínimo de 6 caracteres"></label>'}
          </div>
          ${ed ? '<p class="muted small" style="margin-top:-.4rem">O e-mail de acesso não pode ser alterado. Para trocar a senha, envie o e-mail de redefinição.</p>' : ''}
          <div class="erro" id="erroCat"></div>
          <div class="acoes">
            ${botaoSalvar(ed, 'btnCat')}
            ${ed ? '<button class="btn secundario" type="button" id="btnRedefinir">Enviar e-mail de redefinição de senha</button>' : ''}
            ${botaoCancelar(ed)}
          </div>
        </form>
      </section>
      <section class="card">
        <h2>Paioleiros cadastrados</h2>
        ${lst.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Nome</th><th>Usuário/e-mail</th><th>Perfil</th><th></th></tr></thead>
          <tbody>${lst.map(u => `<tr>
            <td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>Paioleiro</td>
            <td class="num" style="white-space:nowrap"><button class="btn secundario pequeno" data-edit="${u.id}">Editar</button> ${botaoExcluir(u)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum paioleiro cadastrado.</p>'}
      </section>
      ${historicoExclusoesHtml(ehPerfilPaioleiro)}`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.paioleiros(p, b.dataset.edit));
      ligarExclusao(p, 'paioleiros');
      const erro = msg => { $('erroCat').textContent = msg; };
      if (ed) {
        $('btnCancelar').onclick = () => PAINEIS.paioleiros(p);
        $('btnRedefinir').onclick = () => comBotao($('btnRedefinir'), async () => {
          try {
            await sendPasswordResetEmail(auth, ed.email);
            erro('');
            p.insertAdjacentHTML('afterbegin', `<div class="aviso">E-mail de redefinição enviado para ${esc(ed.email)}.</div>`);
          } catch (err) { erro(msgErro(err)); }
        });
      }

      $('fCat').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const nome = String(f.get('nome')).trim();
        const email = ed ? ed.email : String(f.get('email')).trim();
        const senha = ed ? '' : String(f.get('senha'));
        if (!nome) return erro('Informe o nome.');
        if (!ed && !/^\S+@\S+\.\S+$/.test(email)) return erro('Informe um e-mail válido.');
        if (!ed && senha.length < 6) return erro('A senha inicial deve ter pelo menos 6 caracteres.');
        comBotao($('btnCat'), async () => {
          try {
            if (ed) {
              await updateDoc(doc(db, 'usuarios', ed.id), { nome });
              return salvo('paioleiros', 'Paioleiro atualizado.');
            }
            const uid = await criarAcesso(email, senha);
            try {
              await setDoc(doc(db, 'usuarios', uid), { nome, email, perfil: 'paioleiro' });
            } catch (err) {
              return erro('O acesso foi criado, mas o perfil não foi salvo (' + msgErro(err) + ').');
            }
            salvo('paioleiros', 'Paioleiro cadastrado.');
          } catch (err) { erro(msgErro(err)); }
        });
      };
    },

    /* ---- Responsáveis ---- */
    responsaveis(p, editId) {
      const resp = dados.usuarios.filter(u => u.perfil === 'responsavel').sort((a, b) => a.nome.localeCompare(b.nome));
      const ed = editId ? dados.usuarios.find(u => u.id === editId) : null;
      p.innerHTML = `
      <section class="card">
        <h2>${ed ? 'Editar responsável' : 'Cadastrar responsável'}</h2>
        <form id="fResp" novalidate>
          <div class="grade">
            <label>Nome<input name="nome" value="${esc(ed?.nome)}"></label>
            <label>Usuário/e-mail<input type="email" name="email" value="${esc(ed?.email)}" autocomplete="off" ${ed ? 'readonly' : ''}></label>
            ${ed ? '' : '<label>Senha inicial<input type="password" name="senha" autocomplete="new-password" placeholder="Mínimo de 6 caracteres"></label>'}
            <label>Modalidade
              <select name="modalidade">
                <option value="">Selecione</option>
                ${dados.modalidades.map(m => `<option value="${m.id}" ${ed?.modalidadeId === m.id ? 'selected' : ''}>${esc(m.nome)}</option>`).join('')}
              </select>
            </label>
          </div>
          ${ed ? '<p class="muted small" style="margin-top:-.4rem">O e-mail de acesso não pode ser alterado. Para trocar a senha, envie o e-mail de redefinição ao responsável.</p>' : ''}
          <div class="erro" id="erroResp"></div>
          <div class="acoes">
            ${botaoSalvar(ed, 'btnResp')}
            ${ed ? '<button class="btn secundario" type="button" id="btnRedefinir">Enviar e-mail de redefinição de senha</button>' : ''}
            ${botaoCancelar(ed)}
          </div>
        </form>
      </section>
      <section class="card">
        <h2>Responsáveis cadastrados</h2>
        ${resp.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Nome</th><th>Usuário/e-mail</th><th>Perfil</th><th>Modalidade</th><th></th></tr></thead>
          <tbody>${resp.map(u => `<tr>
            <td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>Responsável</td><td>${esc(modalidade(u.modalidadeId)?.nome ?? '—')}</td>
            <td class="num" style="white-space:nowrap"><button class="btn secundario pequeno" data-edit="${u.id}">Editar</button> ${botaoExcluir(u)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum responsável cadastrado.</p>'}
      </section>
      ${historicoExclusoesHtml(x => x.perfil === 'responsavel')}`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.responsaveis(p, b.dataset.edit));
      ligarExclusao(p, 'responsaveis');
      const erro = msg => { $('erroResp').textContent = msg; };

      if (ed) {
        $('btnCancelar').onclick = () => PAINEIS.responsaveis(p);
        $('btnRedefinir').onclick = () => comBotao($('btnRedefinir'), async () => {
          try {
            await sendPasswordResetEmail(auth, ed.email);
            erro('');
            p.insertAdjacentHTML('afterbegin', `<div class="aviso">E-mail de redefinição enviado para ${esc(ed.email)}.</div>`);
          } catch (err) { erro(msgErro(err)); }
        });
      }

      $('fResp').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const nome = String(f.get('nome')).trim();
        const email = ed ? ed.email : String(f.get('email')).trim();
        const senha = ed ? '' : String(f.get('senha'));
        const modId = String(f.get('modalidade'));
        if (!nome) return erro('Informe o nome.');
        if (!ed && !/^\S+@\S+\.\S+$/.test(email)) return erro('Informe um e-mail válido.');
        if (!ed && senha.length < 6) return erro('A senha inicial deve ter pelo menos 6 caracteres.');
        if (!modId) return erro('Selecione a modalidade.');
        const ocupante = dados.usuarios.find(u => u.modalidadeId === modId && u.id !== ed?.id);
        if (ocupante) return erro(`A modalidade selecionada já possui o responsável ${ocupante.nome}.`);

        comBotao($('btnResp'), async () => {
          try {
            if (ed) {
              await updateDoc(doc(db, 'usuarios', ed.id), { nome, modalidadeId: modId });
              return salvo('responsaveis', 'Responsável atualizado.');
            }
            const uid = await criarAcesso(email, senha);
            try {
              await setDoc(doc(db, 'usuarios', uid), { nome, email, perfil: 'responsavel', modalidadeId: modId });
            } catch (err) {
              return erro('O acesso foi criado, mas o perfil não foi salvo (' + msgErro(err) + ').');
            }
            salvo('responsaveis', 'Responsável cadastrado.');
          } catch (err) { erro(msgErro(err)); }
        });
      };
    }

  };
})();
