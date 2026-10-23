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
    query, where, serverTimestamp, writeBatch, increment, onSnapshot
  } = fbStore;

  const firebaseApp = initializeApp(cfg);
  const auth = getAuth(firebaseApp);
  const db = getFirestore(firebaseApp);

  /* ---------- Estado ---------- */
  let perfil = null;        // { uid, nome, email, perfil, modalidadeId }
  let mensagemLogin = '';
  let dados = vazio();
  let filtroSolicitacoes = 'todas';
  const gruposRecolhidos = new Set();   // datas minimizadas na lista de solicitações do Administrador
  let filtroData = 'todas';
  const filtroHistorico = { tipo: '', de: '', ate: '', admin: '' }; // filtros do Histórico de Exclusões   // data da retirada selecionada no painel de solicitações
  // Quem está usando o painel de solicitações (Administrador ou Paioleiro).
  const CTX_ADMIN = { papel: 'admin', recarregar: msg => telaAdmin('solicitacoes', msg, true) };
  const CTX_PAIOLEIRO = { papel: 'paioleiro', recarregar: msg => telaPaioleiro(msg) };
  // Perfil "paioleiro" (o valor antigo "catanheiro" continua aceito para acessos já criados).
  const ehPerfilPaioleiro = u => !!u && (u.perfil === 'paioleiro' || u.perfil === 'catanheiro');
  let ctxSol = CTX_ADMIN;

  function vazio() {
    return { modalidades: [], eventos: [], usuarios: [], solicitacoes: [], itens: [], movimentos: [], exclusoes: [], auditoria: [], contadores: [], vales: [] };
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
  // Quantidades: inteiros ou decimais (até 3 casas), digitados com vírgula ou ponto.
  // São gravados como número no Firebase. EPS absorve diferenças de arredondamento.
  const EPS = 0.0005;
  const arred = n => Math.round(Number(n) * 1000) / 1000;
  const maior = (a, b) => a - b > EPS;            // a > b, com tolerância
  function paraNumero(txt) {
    const t = String(txt ?? '').trim().replace(/\s/g, '');
    if (t === '') return null;
    if (!/^\d+([.,]\d{1,3})?$/.test(t)) return NaN;   // recusa ",", ".", "1,2,3", "abc", negativos
    return arred(parseFloat(t.replace(',', '.')));
  }
  // Contagens (ex.: limite de pedidos por dia): somente inteiros.
  function paraInteiro(txt) {
    const t = String(txt ?? '').trim();
    if (t === '') return null;
    if (!/^\d+$/.test(t)) return NaN;
    return Number(t);
  }
  const fmtQtd = n => { const v = arred(n || 0); return (Math.abs(v) < EPS ? 0 : v).toLocaleString('pt-BR', { maximumFractionDigits: 3 }); };
  const qtdUn = (n, un) => `${fmtQtd(n)} ${un || ''}`.trim();
  const editavel = n => n == null ? '' : fmtQtd(n).replace(/\./g, '');
  const DICA_DECIMAL = 'aceita decimais, ex.: 1,5';
  const inteiro = txt => {
    const t = String(txt ?? '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isInteger(n) ? n : NaN;
  };

  const modalidade = id => dados.modalidades.find(m => m.id === id);
  // Nome do setor para exibição ("setor" na tela = coleção "modalidades" no banco).
  // Se o setor foi excluído, usa o nome guardado no Histórico de Exclusões.
  const nomeSetor = id => modalidade(id)?.nome
    ?? (dados.exclusoes || []).find(x => x.tipo === 'setor' && x.refId === id)?.nome
    ?? '—';
  const evento = id => dados.eventos.find(e => e.id === id);
  const item = id => dados.itens.find(i => i.id === id);
  const unidadeDoItem = id => item(id)?.unidade ?? (dados.exclusoes || []).find(x => x.tipo === 'item' && x.refId === id)?.unidade ?? '';
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
      return s.fornecidos && Math.abs(f - i.quantidade) > EPS
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
    pararSaldo();
    mensagemLogin = mensagem || '';
    dados = vazio();
    mesCalendario = null;   // o calendário volta ao mês atual no próximo acesso
    dataSelecionada = null;
    filtroData = 'todas';
    gruposRecolhidos.clear();
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
      return sair('Usuário sem setor vinculado. Procure o Administrador.');
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
      const [mSnap, eventos, itens, solicitacoes, contadores] = await Promise.all([
        getDoc(doc(db, 'modalidades', perfil.modalidadeId)),
        // Eventos: apenas para exibir a data de solicitações antigas (anteriores ao calendário).
        listaConsulta(query(collection(db, 'eventos'), where('modalidadeId', '==', perfil.modalidadeId))).catch(() => []),
        lista('itens'),
        listaConsulta(query(collection(db, 'solicitacoes'), where('modalidadeId', '==', perfil.modalidadeId))),
        listaConsulta(query(collection(db, 'contadores'), where('setorId', '==', perfil.modalidadeId))).catch(() => [])
      ]);
      if (!mSnap.exists()) return sair('O setor vinculado ao seu acesso não foi encontrado. Procure o Administrador.');
      mod = { id: mSnap.id, ...mSnap.data() };
      dados = { ...vazio(), modalidades: [mod], eventos, itens, solicitacoes, contadores };
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
        <h2>Solicitações do setor</h2>
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

  // Limite diário de QUANTIDADE do setor (campo "limite" do setor, definido pelo
  // Administrador): a soma das quantidades de todas as solicitações do setor na mesma
  // data não pode ultrapassá-lo. É independente do limite de NÚMERO de pedidos por dia.
  function msgLimiteModalidade(m, jaSolicitado, tentando) {
    if (m.limite == null) return 'O limite diário de quantidade deste setor ainda não foi definido pelo Administrador.';
    const disp = Math.max(0, arred(m.limite - jaSolicitado));
    return `Limite diário de quantidade ultrapassado.\n` +
      `• Limite diário definido pelo Administrador: ${fmtQtd(m.limite)}\n` +
      `• Quantidade já solicitada nesta data: ${fmtQtd(jaSolicitado)}\n` +
      `• Quantidade ainda disponível: ${fmtQtd(disp)}\n` +
      `• Quantidade que você está tentando solicitar: ${fmtQtd(tentando)}`;
  }
  const msgPrazoEncerrado = dt => `O prazo para solicitar para ${fmtData(dt)} encerrou às ${PRAZO_TEXTO} (horário de Brasília). Não é mais possível solicitar para esta data.`;
  const MSG_DATA_PASSADA = 'Não é possível solicitar para datas anteriores a hoje.';
  // ---------- Limite de pedidos por dia (por setor) ----------
  // Cada setor tem seu "Limite de pedidos por dia" (padrão: 1). A contagem é por data
  // de retirada e fica no documento contadores/{setor}_{data}; cada nova solicitação
  // ocupa a posição seguinte (id {setor}_{data}_{n}). Conta solicitações, não itens.
  const limiteDia = m => (Number.isInteger(m?.limiteDiario) && m.limiteDiario >= 1) ? m.limiteDiario : 1;
  const idContador = (setorId, dt) => `${setorId}_${dt}`;
  function usadosNaData(dt) {
    const c = (dados.contadores || []).find(x => x.data === dt);
    return Math.max(c ? c.n || 0 : 0, dados.solicitacoes.filter(s => dataDe(s) === dt).length);
  }
  // Soma das quantidades já solicitadas pelo setor na data (contador no Firebase).
  function quantidadeNaData(dt) {
    const c = (dados.contadores || []).find(x => x.data === dt);
    const soma = arred(dados.solicitacoes.filter(s => dataDe(s) === dt).reduce((t, s) => t + (s.quantidade || 0), 0));
    return Math.max(c ? c.total || 0 : 0, soma);
  }
  const disponivelNaData = (mod, dt) => mod.limite == null ? 0 : Math.max(0, arred(mod.limite - quantidadeNaData(dt)));
  const msgQuantidadeEsgotada = (mod, dt) => `Seu setor já solicitou toda a quantidade diária permitida para ${fmtData(dt)} (limite diário: ${fmtQtd(mod.limite ?? 0)}). Não é possível fazer novas solicitações para esta data.`;
  const restantesNaData = (mod, dt) => Math.max(0, limiteDia(mod) - usadosNaData(dt));
  const msgLimiteDiario = (mod, dt) => `Seu setor já atingiu o limite diário de ${plural(limiteDia(mod), 'pedido', 'pedidos')} para ${fmtData(dt)}. Não é possível fazer novas solicitações para esta data.`;

  // ---------- Calendário ----------
  function desenharCalendario(mod, aviso) {
    const { ano, mes } = mesCalendario;
    const hoje = hojeISO();
    const mesAtual = hoje.slice(0, 7) === `${ano}-${String(mes).padStart(2, '0')}`;
    const primeiroDiaSemana = new Date(Date.UTC(ano, mes - 1, 1)).getUTCDay();
    const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const limite = limiteDia(mod);

    let celulas = '';
    for (let i = 0; i < primeiroDiaSemana; i++) celulas += '<div class="dia vazio"></div>';
    for (let dia = 1; dia <= diasNoMes; dia++) {
      const dt = isoData(ano, mes, dia);
      const sit = situacaoData(dt);
      const usados = usadosNaData(dt);
      const cheio = usados >= limite || (mod.limite != null && !(disponivelNaData(mod, dt) > EPS));
      const classes = ['dia', sit, dt === hoje ? 'hoje' : '', cheio ? 'solicitado' : usados ? 'parcial' : '', dt === dataSelecionada ? 'selecionado' : ''].join(' ');
      const titulo = sit === 'passada' ? 'Data anterior a hoje'
        : sit === 'encerrada' ? `Prazo encerrado (${PRAZO_TEXTO})`
        : cheio ? `Limite diário atingido (${usados}/${limite} pedidos; ${fmtQtd(quantidadeNaData(dt))} de ${fmtQtd(mod.limite ?? 0)} em quantidade)` : usados ? `${usados} de ${limite} pedidos feitos` : 'Disponível';
      celulas += `<button type="button" class="${classes}" data-dia="${dt}" ${sit === 'passada' ? 'disabled' : ''} title="${titulo}" aria-label="${fmtData(dt)}: ${titulo}">
        <span class="num-dia">${dia}</span>${usados ? `<span class="marca-dia">${cheio ? '✓' : ''}${limite > 1 ? `${usados}/${limite}` : ''}</span>` : sit === 'encerrada' ? '<span class="marca-dia">⏱</span>' : ''}
      </button>`;
    }

    $('secCalendario').innerHTML = `
      <h2>Escolha a data da retirada</h2>
      <p class="muted small" style="margin-top:-.3rem">Solicitações até as <strong>${PRAZO_TEXTO} do próprio dia</strong> da retirada (horário de Brasília). Retirada sempre das <strong>${RETIRADA_TEXTO}</strong>. Limites diários do seu setor: <strong>${plural(limiteDia(mod), 'pedido', 'pedidos')}</strong> e <strong>${mod.limite != null ? fmtQtd(mod.limite) : '—'} de quantidade</strong> (soma de todos os pedidos da data).</p>
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
          <span><i class="leg parcial"></i>Com pedidos (ainda há vagas)</span>
          <span><i class="leg solicitado"></i>Limite diário atingido</span>
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
      if (restantesNaData(mod, dt) <= 0) { dataSelecionada = null; $('secSolicitacao').hidden = true; return desenharCalendario(mod, msgLimiteDiario(mod, dt)); }
      if (mod.limite != null && !(disponivelNaData(mod, dt) > EPS)) { dataSelecionada = null; $('secSolicitacao').hidden = true; return desenharCalendario(mod, msgQuantidadeEsgotada(mod, dt)); }
      dataSelecionada = dt;
      desenharCalendario(mod);
      formularioSolicitacao(mod, { data: dt });
      $('secSolicitacao').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  }

  // Validação usada no formulário e novamente antes de gravar (com dados atualizados).
  // Cada item marcado recebe a mesma quantidade solicitada.
  // A baixa no estoque só ocorre quando o pedido é marcado como "Fornecido".
  function validarSolicitacao(mod, d, catalogo, jaSolicitado = 0) {
    const erros = [], itens = [];
    const sit = situacaoData(d.data);
    if (sit === 'passada') erros.push(MSG_DATA_PASSADA);
    if (sit === 'encerrada') erros.push(msgPrazoEncerrado(d.data));
    if (mod.limite == null || maior(jaSolicitado + d.quantidade, mod.limite)) erros.push(msgLimiteModalidade(mod, jaSolicitado, d.quantidade));
    if (!d.itemIds.length) erros.push('Selecione pelo menos um item para compor o pedido.');
    if (d.itemIds.length > MAX_ITENS_POR_SOLICITACAO) erros.push(`Selecione no máximo ${MAX_ITENS_POR_SOLICITACAO} itens por solicitação.`);
    for (const id of d.itemIds) {
      const atual = catalogo.find(c => c.id === id);
      if (!atual || !atual.ativo) { erros.push('Um dos itens selecionados não está mais disponível.'); continue; }
      const total = d.quantidade;
      if (maior(total, atual.saldo))
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
        <label>Setor<input value="${esc(mod.nome)}" readonly></label>
        <label>Data da retirada<input id="inpData" value="${esc(fmtDataSemana(valores.data))}" readonly></label>
        <div class="retirada-fixa">
          <span class="rotulo">Horário de retirada</span>
          <strong>${RETIRADA_TEXTO}</strong>
          <span class="small">Horário fixo para todas as solicitações.</span>
        </div>
        <p class="muted small" style="margin-top:-.3rem">Prazo para enviar: até as ${PRAZO_TEXTO} de ${esc(fmtData(valores.data))} (horário de Brasília).</p>
        <div class="aviso" id="avisoRestantes">Para esta data você ainda pode fazer <strong>${plural(restantesNaData(mod, valores.data), 'pedido', 'pedidos')}</strong> (limite: ${plural(limiteDia(mod), 'pedido', 'pedidos')} por dia)
          e solicitar até <strong>${fmtQtd(disponivelNaData(mod, valores.data))}</strong> de quantidade (limite diário: ${mod.limite != null ? fmtQtd(mod.limite) : 'não definido'}; já solicitado: ${fmtQtd(quantidadeNaData(valores.data))}).</div>
        <label>Quantidade
          <input type="text" id="inpQtd" inputmode="decimal" placeholder="ex.: 10 ou 2,5" value="${editavel(valores.quantidade)}">
        </label>
        <p class="muted small" style="margin-top:-.5rem">
          ${mod.limite != null ? `A soma dos pedidos do setor na data não pode passar de ${fmtQtd(mod.limite)}.` : 'Limite diário de quantidade ainda não definido pelo Administrador.'}
        </p>

        <h3 style="font-size:1rem;margin-top:1rem">Itens do pedido</h3>
        ${disponiveis.length ? `
        <p class="muted small" style="margin-top:-.3rem">Marque os itens que vão compor o pedido (até ${MAX_ITENS_POR_SOLICITACAO} itens). Cada item marcado terá a mesma quantidade solicitada.</p>
        <div class="tabela-wrap itens-sol"><table>
          <thead><tr><th style="width:2.5rem"></th><th>Item</th><th>Unidade</th></tr></thead>
          <tbody>${disponiveis.map(i => {
            const semEstoque = !(i.saldo > EPS);
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
      const quantidade = paraNumero($('inpQtd').value);
      if (restantesNaData(mod, valores.data) <= 0) return erro(msgLimiteDiario(mod, valores.data));
      if (quantidade == null || Number.isNaN(quantidade) || !(quantidade > EPS)) return erro(`Informe uma quantidade válida, maior que zero (${DICA_DECIMAL}; até 3 casas decimais).`);
      const itemIds = [...document.querySelectorAll('[data-item]:checked')].map(c => c.dataset.item);
      const d = { data: valores.data, quantidade, itemIds };
      const { erros, itens } = validarSolicitacao(mod, d, dados.itens, quantidadeNaData(d.data));
      if (erros.length) return erro(erros.join('\n'));
      d.itens = itens;
      resumoSolicitacao(mod, d);
    };
  }

  function resumoSolicitacao(mod, d) {
    $('secSolicitacao').innerHTML = `
      <h2>Resumo da solicitação</h2>
      <p class="muted">Confira os dados antes de confirmar.</p>
      <dl class="resumo">
        <dt>Setor</dt><dd>${esc(mod.nome)}</dd>
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
      const contRef = doc(db, 'contadores', idContador(mod.id, d.data));
      let itensMap, modAtual;
      try {
        // Confere limites e estoque com os dados mais recentes.
        const [mSnap, ...snaps] = await Promise.all([
          getDoc(doc(db, 'modalidades', mod.id)),
          ...d.itemIds.map(id => getDoc(doc(db, 'itens', id)))
        ]);
        modAtual = { id: mSnap.id, ...mSnap.data() };
        const catalogo = snaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));
        const { erros, itens } = validarSolicitacao(modAtual, d, catalogo, 0);
        if (erros.length) return erro(erros.join('\n'));
        itensMap = {};
        itens.forEach(i => { itensMap[i.id] = { nome: i.nome, unidade: i.unidade, quantidade: i.quantidade }; });
      } catch (e) { return erro(msgErro(e)); }

      // Ocupa a próxima posição do dia. Se outra solicitação do setor for gravada ao
      // mesmo tempo, o Firebase recusa uma delas e o sistema tenta a posição seguinte.
      for (let tentativa = 0; tentativa < 4; tentativa++) {
        let n, totalAnterior;
        try {
          const cSnap = await getDoc(contRef);
          n = (cSnap.exists() ? cSnap.data().n || 0 : 0) + 1;
          totalAnterior = cSnap.exists() ? cSnap.data().total || 0 : 0;
        } catch (e) { return erro(msgErro(e)); }
        const usadosAgora = Math.max(n - 1, dados.solicitacoes.filter(s => dataDe(s) === d.data).length);
        if (usadosAgora >= limiteDia(modAtual)) return erro(msgLimiteDiario(modAtual, d.data));
        // Soma acumulada do setor na data (o Firebase confere a mesma conta).
        const jaSolicitado = Math.max(totalAnterior, quantidadeNaData(d.data));
        if (modAtual.limite == null || maior(jaSolicitado + d.quantidade, modAtual.limite))
          return erro(msgLimiteModalidade(modAtual, jaSolicitado, d.quantidade));
        const solRef = doc(db, 'solicitacoes', `${mod.id}_${d.data}_${n}`);
        try {
          const lote = writeBatch(db);
          lote.set(contRef, { setorId: mod.id, data: d.data, n, total: arred(totalAnterior + d.quantidade) });
          // A solicitação não mexe no estoque: a baixa é feita no "Fornecido".
          lote.set(solRef, {
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
          await lote.commit();
          return telaResponsavel('Solicitação registrada com sucesso.');
        } catch (e) {
          // Se a gravação chegou ao servidor e só a resposta se perdeu, não repete.
          try {
            const ja = await getDoc(solRef);
            if (ja.exists() && ja.data().usuarioId === perfil.uid) return telaResponsavel('Solicitação registrada com sucesso.');
          } catch (_) { /* sem acesso ou sem conexão */ }
          if (e.code !== 'permission-denied') return erro(msgErro(e));
          if (situacaoData(d.data) !== 'aberta') return erro(msgPrazoEncerrado(d.data));
          // Outra solicitação ocupou esta posição: tenta de novo com o contador atualizado.
        }
      }
      erro('Não foi possível registrar: o prazo, o limite diário, o estoque ou os limites foram alterados. Volte e revise a solicitação.');
    });
  }

  /* ================= Administrador ================= */
  const ABAS = [
    ['solicitacoes', 'Solicitações'],
    ['itens', 'Itens e estoque'],
    ['modalidades', 'Setores e limites'],
    ['responsaveis', 'Responsáveis'],
    ['paioleiros', 'Paioleiros'],
    ['administradores', 'Administradores'],
    ['vales', 'Vales de Gêneros']
  ];

  async function garantirModalidades(exclusoes = []) {
    const atuais = await lista('modalidades');
    if (atuais.length) return ordenarModalidades(atuais);
    // Não recria os setores iniciais se eles foram excluídos de propósito.
    if (exclusoes.some(x => x.tipo === 'setor')) return [];
    const b = writeBatch(db);
    MODALIDADES_INICIAIS.forEach((nome, i) =>
      b.set(doc(db, 'modalidades', 'm' + String(i + 1).padStart(2, '0')), { nome, limite: null, limiteDiario: 1, ordem: i + 1 }));
    await b.commit();
    return ordenarModalidades(await lista('modalidades'));
  }

  // Os dados são carregados ao entrar, ao clicar em "Atualizar" e após cada gravação.
  async function telaAdmin(aba, mensagem, recarregar) {
    if (recarregar) {
      app.innerHTML = CARREGANDO;
      try {
        const exclusoes = await lista('exclusoes').catch(() => []);
        const [modalidades, eventos, usuarios, solicitacoes, itens, movimentos, auditoria, vales] = await Promise.all([
          garantirModalidades(exclusoes), lista('eventos').catch(() => []), lista('usuarios'), lista('solicitacoes'), lista('itens'), lista('movimentos'),
          lista('auditoria').catch(() => []), lista('vales').catch(() => [])
        ]);
        dados = { modalidades, eventos, usuarios, solicitacoes, itens, movimentos, exclusoes, auditoria, vales };
      } catch (e) {
        return telaFalha('Administrador', e, () => telaAdmin(aba, '', true));
      }
    }
    app.innerHTML = cabecalho('Administrador', true) + `
      <nav class="abas">${ABAS.map(([k, t]) => `<button data-aba="${k}" class="${k === aba ? 'ativa' : ''}">${t}</button>`).join('')}
        <button data-aba="historico" class="aba-icone ${aba === 'historico' ? 'ativa' : ''}" title="Histórico de Exclusões" aria-label="Histórico de Exclusões">🗂 Histórico de Exclusões</button></nav>
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

  /* ================= Exclusões (somente Administrador) ================= */
  // Toda exclusão é gravada no Firebase e registrada na coleção "exclusoes"
  // (Histórico de Exclusões), que guarda o nome e a identificação do que foi excluído.
  // Solicitações, fornecimentos, registros de alteração e movimentações NÃO são apagados
  // por essas operações e continuam identificando os usuários pelo nome.
  // Usuários: o cadastro é excluído (o que bloqueia todo o acesso) e o login no Firebase
  // Authentication é removido pelo Administrador no Console (no plano gratuito, o
  // navegador não pode apagar o login de outra pessoa).
  const TIPOS_EXCLUSAO = { setor: 'Setor', responsavel: 'Responsável', paioleiro: 'Paioleiro', administrador: 'Administrador', item: 'Item', historico: 'Histórico' };
  const nomePerfil = u => u.perfil === 'responsavel' ? 'Responsável' : ehPerfilPaioleiro(u) ? 'Paioleiro' : 'Administrador';
  const tipoDoUsuario = u => u.perfil === 'responsavel' ? 'responsavel' : u.perfil === 'admin' ? 'administrador' : 'paioleiro';
  const botaoExcluir = (id, attr = 'data-excluir') => `<button class="btn perigo pequeno" ${attr}="${id}">Excluir</button>`;
  const AVISO_IRREVERSIVEL = 'Esta exclusão é definitiva. O plano gratuito do Firebase não possui backup: os registros apagados não poderão ser recuperados.';

  // Registros antigos do histórico (versão anterior) são lidos no formato novo.
  function normalizarExclusao(x) {
    return {
      ...x,
      tipo: x.tipo || (x.perfil === 'responsavel' ? 'responsavel' : 'paioleiro'),
      identificacao: x.identificacao ?? x.email ?? '',
      refId: x.refId ?? x.id,
      setorId: x.setorId ?? x.modalidadeId ?? null,
      operacao: x.operacao || 'individual',
      resultado: x.resultado || 'concluida',
      detalhe: x.detalhe || ''
    };
  }
  const exclusoesNorm = () => (dados.exclusoes || []).map(normalizarExclusao);

  function dadosRegistro(tipo, nome, identificacao, refId, operacao, resultado, detalhe, extra = {}) {
    return {
      tipo, nome: String(nome || '—'), identificacao: String(identificacao || ''), refId: String(refId || ''),
      setorId: extra.setorId ?? null, unidade: extra.unidade ?? null,
      operacao, resultado, detalhe: String(detalhe || '').slice(0, 500),
      excluidoEm: serverTimestamp(), porUid: perfil.uid, porNome: perfil.nome
    };
  }
  async function registrarFalha(tipo, nome, identificacao, refId, operacao, detalhe, extra) {
    try { await addDoc(collection(db, 'exclusoes'), dadosRegistro(tipo, nome, identificacao, refId, operacao, 'falha', detalhe, extra)); }
    catch (_) { /* sem permissão ou sem conexão: a falha é mostrada na tela */ }
  }

  // Painel de confirmação genérico (Cancelar / Confirmar).
  function abrirConfirmacao(p, { titulo, corpo, bloqueio, rotuloConfirmar, aoConfirmar, extraAcoes = '' }) {
    $('secExcluir')?.remove();
    p.insertAdjacentHTML('afterbegin', `
      <section class="card exclusao" id="secExcluir">
        <h2>${titulo}</h2>
        ${corpo}
        <div class="erro" id="erroExcluir">${esc(bloqueio || '')}</div>
        <div class="acoes">
          <button class="btn secundario" id="btnCancelarExcluir">Cancelar</button>
          ${bloqueio ? '' : `<button class="btn perigo-cheio" id="btnConfirmarExcluir">${rotuloConfirmar || 'Confirmar exclusão'}</button>`}
          ${extraAcoes}
        </div>
      </section>`);
    $('secExcluir').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    $('btnCancelarExcluir').onclick = () => $('secExcluir').remove();
    if (!bloqueio) $('btnConfirmarExcluir').onclick = () => comBotao($('btnConfirmarExcluir'), () => aoConfirmar(msg => { $('erroExcluir').textContent = msg; }));
  }

  // ---------- Usuários: individual e em lote ----------
  function ligarExclusaoUsuarios(p, aba) {
    const marcados = () => [...p.querySelectorAll('[data-sel-usuario]:checked')].map(c => c.dataset.selUsuario);
    const barra = () => {
      const n = marcados().length;
      $('barraLote').hidden = n === 0;
      $('qtdSelecionados').textContent = plural(n, 'usuário selecionado', 'usuários selecionados');
    };
    p.querySelectorAll('[data-sel-usuario]').forEach(c => c.onchange = barra);
    const todos = $('selTodosUsuarios');
    if (todos) todos.onchange = () => { p.querySelectorAll('[data-sel-usuario]').forEach(c => { c.checked = todos.checked; }); barra(); };
    p.querySelectorAll('[data-excluir]').forEach(b => b.onclick = () => confirmarExclusaoUsuarios(p, aba, [b.dataset.excluir], 'individual'));
    const bLote = $('btnExcluirSelecionados');
    if (bLote) bLote.onclick = () => confirmarExclusaoUsuarios(p, aba, marcados(), 'lote');
  }

  function confirmarExclusaoUsuarios(p, aba, ids, operacao) {
    const lista = ids.map(id => dados.usuarios.find(u => u.id === id)).filter(Boolean);
    if (!lista.length) return;
    // Nunca a própria conta; e sempre deve sobrar ao menos um administrador ativo.
    const admins = dados.usuarios.filter(u => u.perfil === 'admin');
    const adminsNaLista = lista.filter(u => u.perfil === 'admin').length;
    const bloqueio = lista.some(u => u.id === perfil.uid) ? 'Você não pode excluir a própria conta.'
      : (adminsNaLista && admins.length - adminsNaLista < 1) ? 'Não é possível excluir a última conta administrativa ativa.' : '';
    abrirConfirmacao(p, {
      titulo: lista.length === 1 ? 'Excluir usuário' : `Excluir ${lista.length} usuários selecionados`,
      bloqueio,
      corpo: `
        <p><strong>${plural(lista.length, 'usuário será excluído', 'usuários serão excluídos')}:</strong></p>
        <div class="tabela-wrap"><table>
          <thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Setor</th></tr></thead>
          <tbody>${lista.map(u => `<tr><td><strong>${esc(u.nome)}</strong></td><td>${esc(u.email || '—')}</td><td>${esc(nomePerfil(u))}</td>
            <td>${u.perfil === 'responsavel' ? esc(nomeSetor(u.modalidadeId)) : '—'}</td></tr>`).join('')}</tbody></table></div>
        <p class="small">O cadastro de cada usuário será <strong>excluído</strong> e o acesso ao sistema ficará <strong>bloqueado imediatamente</strong>.
          Solicitações, fornecimentos, registros de alteração de quantidade e movimentações de estoque <strong>não serão apagados</strong>
          e continuarão identificando os usuários pelo nome. Depois, remova os logins em Firebase → Authentication → Usuários.</p>`,
      rotuloConfirmar: lista.length === 1 ? 'Confirmar exclusão' : `Confirmar exclusão de ${lista.length} usuários`,
      aoConfirmar: async erro => {
        const ok = [], falhas = [];
        for (const u of lista) {
          try {
            const lote = writeBatch(db);
            if (u.perfil === 'admin') {
              // Exclusões de administradores passam por um controle único (config/admins),
              // para que duas exclusões simultâneas não deixem o sistema sem administrador.
              const cSnap = await getDoc(doc(db, 'config', 'admins'));
              lote.set(doc(db, 'config', 'admins'), {
                versao: (cSnap.exists() ? cSnap.data().versao || 0 : 0) + 1,
                ultimaExclusao: u.id, em: serverTimestamp(), porUid: perfil.uid
              });
            }
            lote.delete(doc(db, 'usuarios', u.id));
            lote.set(doc(db, 'exclusoes', u.id), dadosRegistro(tipoDoUsuario(u), u.nome, u.email, u.id, operacao, 'concluida', '', { setorId: u.modalidadeId || null }));
            await lote.commit();
            ok.push(u);
          } catch (err) {
            falhas.push({ u, msg: msgErro(err) });
            await registrarFalha(tipoDoUsuario(u), u.nome, u.email, u.id, operacao, msgErro(err), { setorId: u.modalidadeId || null });
          }
        }
        if (!ok.length) return erro('Nenhum usuário foi excluído.\n' + falhas.map(f => `• ${f.u.nome}: ${f.msg}`).join('\n'));
        const msg = [
          `Concluído: ${ok.map(u => `${u.nome} (${nomePerfil(u)})`).join(', ')}. O acesso ao sistema foi bloqueado.`,
          falhas.length ? `FALHOU: ${falhas.map(f => `${f.u.nome} (${f.msg})`).join(', ')}.` : '',
          `Para concluir, remova no Firebase → Authentication → Usuários: ${ok.map(u => u.email).join(', ')}.`
        ].filter(Boolean).join(' ');
        salvo(aba, msg);
      }
    });
  }

  // Seleção (caixas) + barra "Excluir selecionados" para as tabelas de usuários.
  const cabecalhoSelecao = () => '<th style="width:2.2rem"><input type="checkbox" id="selTodosUsuarios" aria-label="Selecionar todos" class="caixa"></th>';
  const caixaUsuario = u => `<td><input type="checkbox" class="caixa" data-sel-usuario="${u.id}" aria-label="Selecionar ${esc(u.nome)}"></td>`;
  const barraLote = () => `<div class="barra-lote" id="barraLote" hidden>
      <span id="qtdSelecionados"></span>
      <button class="btn perigo-cheio pequeno" id="btnExcluirSelecionados">Excluir selecionados</button>
    </div>`;

  // ---------- Setores ----------
  function confirmarExclusaoSetor(p, m) {
    const responsaveis = dados.usuarios.filter(u => u.modalidadeId === m.id);
    const sols = dados.solicitacoes.filter(s => s.modalidadeId === m.id);
    const ativas = sols.filter(s => ['pendente', 'recebido'].includes(statusDe(s)));
    const concluidas = sols.length - ativas.length;
    const impedimentos = [
      responsaveis.length ? `Responsável vinculado: ${responsaveis.map(u => u.nome).join(', ')} — exclua o responsável ou transfira-o para outro setor.` : '',
      ativas.length ? `${plural(ativas.length, 'solicitação em andamento', 'solicitações em andamento')} (Pendente ou Pedido Recebido) — conclua ou aguarde o fornecimento antes de excluir.` : ''
    ].filter(Boolean);
    abrirConfirmacao(p, {
      titulo: 'Excluir setor',
      bloqueio: impedimentos.length ? 'Não é possível excluir este setor agora:\n' + impedimentos.map(t => '• ' + t).join('\n') : '',
      corpo: `
        <dl class="resumo"><dt>Setor</dt><dd>${esc(m.nome)}</dd><dt>Limite</dt><dd>${m.limite != null ? pedidos(m.limite) : 'não definido'}</dd>
          <dt>Responsáveis</dt><dd>${responsaveis.length}</dd><dt>Solicitações</dt><dd>${sols.length} (${ativas.length} em andamento, ${concluidas} concluídas)</dd></dl>
        ${!impedimentos.length && concluidas ? `<p class="small">As ${plural(concluidas, 'solicitação concluída', 'solicitações concluídas')} deste setor <strong>permanecerão no histórico</strong>, identificadas pelo nome do setor.</p>` : ''}`,
      aoConfirmar: async erro => {
        try {
          const lote = writeBatch(db);
          lote.delete(doc(db, 'modalidades', m.id));
          lote.set(doc(collection(db, 'exclusoes')), dadosRegistro('setor', m.nome, m.id, m.id, 'individual', 'concluida', concluidas ? `${concluidas} solicitações concluídas preservadas` : ''));
          await lote.commit();
          salvo('modalidades', `Setor ${m.nome} excluído.`);
        } catch (err) {
          await registrarFalha('setor', m.nome, m.id, m.id, 'individual', msgErro(err));
          erro('Não foi possível excluir o setor: ' + msgErro(err) + ' Nada foi alterado.');
        }
      }
    });
  }

  // ---------- Itens ----------
  function confirmarExclusaoItem(p, i) {
    const ativas = dados.solicitacoes.filter(s => ['pendente', 'recebido'].includes(statusDe(s)) && s.itens && s.itens[i.id]);
    const movs = dados.movimentos.filter(m => m.itemId === i.id).length;
    const saidas = dados.solicitacoes.filter(s => estoqueBaixado(s) && s.itens && s.itens[i.id]).length;
    const impedimentos = [
      i.saldo > EPS ? `O item possui saldo em estoque (${qtdUn(i.saldo, i.unidade)}).` : '',
      ativas.length ? `O item está em ${plural(ativas.length, 'solicitação em andamento', 'solicitações em andamento')} (Pendente ou Pedido Recebido).` : ''
    ].filter(Boolean);
    abrirConfirmacao(p, {
      titulo: 'Excluir item',
      bloqueio: impedimentos.length ? 'Não é possível excluir este item com segurança:\n' + impedimentos.map(t => '• ' + t).join('\n') +
        (i.ativo ? '\nComo alternativa, você pode desativá-lo: ele deixa de aparecer para os responsáveis e o histórico é mantido.' : '') : '',
      extraAcoes: impedimentos.length && i.ativo ? '<button class="btn primario" id="btnDesativarAlternativa">Desativar item</button>' : '',
      corpo: `
        <dl class="resumo"><dt>Item</dt><dd>${esc(i.nome)}</dd><dt>Saldo</dt><dd>${esc(qtdUn(i.saldo, i.unidade))}</dd>
          <dt>Movimentações</dt><dd>${movs} entradas/estoque inicial · ${saidas} fornecimentos</dd></dl>
        ${!impedimentos.length && (movs || saidas) ? '<p class="small">As movimentações, os fornecimentos e as solicitações anteriores <strong>não serão apagados</strong> e continuarão identificando o item pelo nome.</p>' : ''}`,
      aoConfirmar: async erro => {
        try {
          const lote = writeBatch(db);
          lote.delete(doc(db, 'itens', i.id));
          lote.set(doc(collection(db, 'exclusoes')), dadosRegistro('item', i.nome, i.unidade, i.id, 'individual', 'concluida', `${movs + saidas} movimentações preservadas`, { unidade: i.unidade }));
          await lote.commit();
          salvo('itens', `Item ${i.nome} excluído.`);
        } catch (err) {
          await registrarFalha('item', i.nome, i.unidade, i.id, 'individual', msgErro(err), { unidade: i.unidade });
          erro('Não foi possível excluir o item: ' + msgErro(err) + ' Nada foi alterado.');
        }
      }
    });
    const alt = $('btnDesativarAlternativa');
    if (alt) alt.onclick = () => comBotao(alt, async () => {
      try { await updateDoc(doc(db, 'itens', i.id), { ativo: false }); salvo('itens', `Item ${i.nome} desativado. O histórico foi mantido.`); }
      catch (err) { $('erroExcluir').textContent = msgErro(err); }
    });
  }

  // ---------- Exclusão de históricos ----------
  // registros: [{ id, descricao }]. Apaga em lotes e grava um registro administrativo
  // separado (coleção "auditoria") para cada lote, que não pode ser apagado.
  function confirmarExclusaoHistorico(p, { colecao, nomeHistorico, registros, aba }) {
    if (!registros.length) return;
    abrirConfirmacao(p, {
      titulo: `Excluir histórico — ${nomeHistorico}`,
      corpo: `
        <p><strong>${plural(registros.length, 'registro será apagado', 'registros serão apagados')} definitivamente:</strong></p>
        <ul class="lista-exclusao">${registros.slice(0, 50).map(r => `<li>${esc(r.descricao)}</li>`).join('')}${registros.length > 50 ? `<li>… e mais ${registros.length - 50}</li>` : ''}</ul>
        <div class="aviso-perigo">⚠ ${AVISO_IRREVERSIVEL}</div>
        <p class="small">A ação ficará registrada no "Registro administrativo de exclusões de histórico".</p>`,
      rotuloConfirmar: `Apagar ${plural(registros.length, 'registro', 'registros')}`,
      aoConfirmar: async erro => {
        let apagados = 0; const falhas = [];
        for (let k = 0; k < registros.length; k += 400) {
          const parte = registros.slice(k, k + 400);
          try {
            const lote = writeBatch(db);
            parte.forEach(r => lote.delete(doc(db, colecao, r.id)));
            lote.set(doc(collection(db, 'auditoria')), {
              acao: 'exclusao_historico', colecao, nomeHistorico, quantidade: parte.length,
              descricao: parte.map(r => r.descricao).join(' | ').slice(0, 1500),
              em: serverTimestamp(), porUid: perfil.uid, porNome: perfil.nome
            });
            await lote.commit();
            apagados += parte.length;
          } catch (err) { falhas.push(`${parte.length} registros: ${msgErro(err)}`); }
        }
        if (!apagados) return erro('Nenhum registro foi apagado.\n' + falhas.join('\n'));
        salvo(aba, `${plural(apagados, 'registro apagado', 'registros apagados')} de "${nomeHistorico}".` + (falhas.length ? ` FALHOU: ${falhas.join('; ')}.` : ''));
      }
    });
  }

  /* ================= Vale Extraordinário de Gêneros (CN-42) ================= */
  // Gera, em PDF, o modelo oficial "VALE EXTRAORDINÁRIO DE GÊNEROS" com os fornecimentos
  // efetivamente realizados (status "Fornecido") numa data, um vale por item.
  // A tabela lista apenas os setores; o total do item (em quantidade) fica no campo
  // de total, embaixo. Sem numeração e sem valores em reais. Não altera estoque nem
  // solicitações. Cada vale gerado fica registrado em "vales" para consulta.
  const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.2.1/jspdf.umd.min.js';
  let carregandoJsPDF = null;
  function carregarJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!carregandoJsPDF) carregandoJsPDF = new Promise((ok, falha) => {
      const sc = document.createElement('script');
      sc.src = JSPDF_URL; sc.async = true;
      sc.onload = () => (window.jspdf && window.jspdf.jsPDF) ? ok(window.jspdf.jsPDF) : falha(new Error('jsPDF'));
      sc.onerror = () => { carregandoJsPDF = null; falha(new Error('Não foi possível carregar o gerador de PDF. Verifique a internet.')); };
      document.head.appendChild(sc);
    });
    return carregandoJsPDF;
  }
  const diaBrasilia = ts => { if (!ts || !ts.toMillis) return ''; const b = new Date(ts.toMillis() - FUSO_BRASILIA_MS); return isoData(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate()); };
  const ordemNatural = (x, y) => String(x).localeCompare(String(y), 'pt-BR', { numeric: true, sensitivity: 'base' });
  const chaveVale = (dt, itemId, setorId) => `${dt}_${itemId}_${setorId || 'todos'}`;

  // Fornecimentos ("Fornecido") feitos na data, opcionalmente de um setor.
  const fornecimentosDaData = (dt, setorId) => dados.solicitacoes.filter(s =>
    statusDe(s) === 'fornecido' && diaBrasilia(s.fornecidoEm) === dt && (!setorId || s.modalidadeId === setorId));
  // Itens que aparecem nos fornecimentos da data.
  function itensFornecidosNaData(dt, setorId) {
    const m = new Map();
    fornecimentosDaData(dt, setorId).forEach(s => itensDaSolicitacao(s).forEach(i => { if (!m.has(i.id)) m.set(i.id, { id: i.id, nome: i.nome, unidade: i.unidade }); }));
    return [...m.values()].sort((a, b) => ordemNatural(a.nome, b.nome));
  }

  // Campo PAIOLEIRO do vale: só quem forneceu como Paioleiro. Fornecimentos marcados
  // por um Administrador não colocam o nome dele nesse campo.
  const perfisFornecedores = new Map();       // uid -> { perfil, nome }
  async function conhecerFornecedores() {
    if (perfil) perfisFornecedores.set(perfil.uid, { perfil: perfil.perfil, nome: perfil.nome });
    (dados.usuarios || []).forEach(u => perfisFornecedores.set(u.id, { perfil: u.perfil, nome: u.nome }));
    const uids = [...new Set((dados.solicitacoes || []).map(s => s.fornecidoPorUid).filter(Boolean))].filter(u => !perfisFornecedores.has(u));
    await Promise.all(uids.map(async uid => {
      try { const sn = await getDoc(doc(db, 'usuarios', uid)); perfisFornecedores.set(uid, sn.exists() ? { perfil: sn.data().perfil, nome: sn.data().nome } : { perfil: '' }); }
      catch (e) { perfisFornecedores.set(uid, { perfil: '' }); }   // sem acesso: não é Administrador
    }));
  }
  const fornecedorEhAdmin = uid => (perfisFornecedores.get(uid) || {}).perfil === 'admin';
  const nomeEhDeAdmin = nome => [...perfisFornecedores.values()].some(p => p.perfil === 'admin' && p.nome === nome);
  const somentePaioleiros = nomes => (nomes || []).filter(n => !nomeEhDeAdmin(n));

  // Monta o vale de UM item (sem gravar nada): uma linha por setor.
  function montarVale(dt, itemId, setorId, complementares) {
    const porSetor = new Map(), vistos = new Set(), paioleiros = new Set();
    let unidade = '', nomeItem = '';
    for (const s of fornecimentosDaData(dt, setorId)) {
      const i = itensDaSolicitacao(s).find(x => x.id === itemId);
      if (!i) continue;
      const chave = `${s.id}|${i.id}`;              // impede duplicar o mesmo fornecimento
      if (vistos.has(chave)) continue; vistos.add(chave);
      unidade = i.unidade; nomeItem = i.nome;
      if (s.fornecidoPorNome && !fornecedorEhAdmin(s.fornecidoPorUid)) paioleiros.add(s.fornecidoPorNome);
      const setor = nomeSetor(s.modalidadeId);
      const l = porSetor.get(s.modalidadeId) || { setor, uf: i.unidade, qtdSol: 0, qtdForn: 0, reduzido: false, solicitacoes: [] };
      const forn = qtdFornecida(s, i);
      l.qtdSol = arred(l.qtdSol + i.quantidade); l.qtdForn = arred(l.qtdForn + forn);
      l.reduzido = l.reduzido || maior(i.quantidade, forn); l.solicitacoes.push(s.id);
      porSetor.set(s.modalidadeId, l);
    }
    const linhas = [...porSetor.values()].sort((a, b) => ordemNatural(a.setor, b.setor))
      .map(l => ({ setor: l.setor, uf: l.uf, qtdSol: l.qtdSol, qtdForn: l.qtdForn, obs: l.reduzido ? 'Reduzido' : '', solicitacoes: l.solicitacoes }));
    return {
      data: dt, itemId, itemNome: nomeItem, unidade, setorId: setorId || null,
      setoresNomes: linhas.map(l => l.setor),
      complementares: String(complementares || '').slice(0, 300),
      linhas, paioleiros: [...paioleiros].sort(ordemNatural),
      totalSol: arred(linhas.reduce((t, l) => t + l.qtdSol, 0)),
      totalForn: arred(linhas.reduce((t, l) => t + l.qtdForn, 0)),
      qtdFornecimentos: vistos.size
    };
  }

  // Grava (ou atualiza) o registro do vale, para consulta e nova geração.
  async function registrarVale(conteudo) {
    const ref = doc(db, 'vales', chaveVale(conteudo.data, conteudo.itemId, conteudo.setorId));
    const existente = await getDoc(ref);
    const v = { ...conteudo, atualizadoEm: serverTimestamp(), geradoPorUid: perfil.uid, geradoPorNome: perfil.nome,
      criadoEm: existente.exists() && existente.data().criadoEm ? existente.data().criadoEm : serverTimestamp(),
      geracoes: existente.exists() ? (existente.data().geracoes || 1) + 1 : 1 };
    await setDoc(ref, v);
    return { ...v, id: ref.id };
  }

  // ---------- Desenho do PDF (página Carta, medidas do modelo CN-42, em pontos) ----------
  const VALE_COLS = [63.8, 291.6, 317.1, 359.7, 405.0, 464.3, 510.1, 545.7];   // ITEM | UF | QTD.SOL. | QTD.FORN. | PREÇO UNIT. | PREÇO TOTAL | OBS.
  const VALE_RODAPE = [63.8, 171.8, 248.8, 328.0, 413.0, 483.2, 545.7];
  const VALE_LINHAS_POR_PAGINA = 26, VALE_ALT_LINHA = 14.3, VALE_TOPO_TABELA = 181.8, VALE_FIM_CAB = 210.0;

  // vales: lista de vales (um por item); cada um ocupa uma ou mais páginas.
  function desenharValePDF(JsPDF, vales, assinaturas = {}) {
    const pdf = new JsPDF({ unit: 'pt', format: 'letter' });
    const T = (txt, x, y, tam, est = 'normal', alinh = 'left', larguraMax) => {
      pdf.setFont('times', est); let t = tam; pdf.setFontSize(t);
      if (larguraMax) while (t > 4 && pdf.getTextWidth(String(txt)) > larguraMax) { t -= 0.25; pdf.setFontSize(t); }
      pdf.text(String(txt), x, y, { align: alinh });
    };
    const caber = (txt, larg) => {                    // corta com "…" se não couber nem em 5pt
      pdf.setFont('times', 'normal'); pdf.setFontSize(5); let t = String(txt);
      if (pdf.getTextWidth(t) <= larg) return t;
      while (t.length > 1 && pdf.getTextWidth(t + '…') > larg) t = t.slice(0, -1);
      return t + '…';
    };
    let primeira = true;
    for (const v of vales) {
      const paginas = Math.max(1, Math.ceil(v.linhas.length / VALE_LINHAS_POR_PAGINA));
      const [a, m, d] = v.data.split('-');
      for (let pg = 0; pg < paginas; pg++) {
        if (!primeira) pdf.addPage('letter'); primeira = false;
        pdf.setLineWidth(0.5); pdf.setDrawColor(0); pdf.setTextColor(0);
        // Cabeçalho (igual ao modelo; código do usuário e n.º do documento em branco)
        T('RAMON GROSSO DE ALMEIDA', 109.0, 49.2, 6.5, 'normal', 'center');
        T('Capitão de Fragata', 107.5, 58.4, 9, 'normal', 'center');
        T('Agente Fiscal', 105.2, 67.0, 9, 'normal', 'center');
        T('MARINHA DO BRASIL', 296.4, 42.3, 10.75, 'normal', 'center');
        T('COLÉGIO NAVAL', 299.5, 58.4, 10.75, 'normal', 'center');
        T('VALE EXTRAORDINÁRIO DE GÊNEROS', 302.7, 76.5, 10.5, 'normal', 'center');
        T('CÓD.DO USUÁRIO', 429.1, 31.9, 10.25);
        T('_______________', 429.1, 43.5, 10.25);
        T('N.º DO DOC.', 429.1, 55.0, 10.25);
        T('_______________', 429.1, 66.6, 10.25);
        T('CN-42', 429.1, 89.7, 10.25);
        // Campos
        T('LOCAL SOLICITANTE:', 63.9, 132.5, 10.25, 'bold');
        pdf.setFont('times', 'normal'); pdf.setFontSize(7);
        const local = pdf.getTextWidth(v.setoresNomes.join(', ')) > 364 ? 'Diversos setores (ver coluna ITEM)' : (v.setoresNomes.join(', ') || '—');
        T(local, 180.0, 132.5, 10, 'normal', 'left', 364);
        T('DATA : _______ / ________/ _________', 63.9, 144.4, 10.25, 'bold');
        T(d, 118.1, 143.4, 10, 'normal', 'center'); T(m, 162.5, 143.4, 10, 'normal', 'center'); T(a, 211.1, 143.4, 10, 'normal', 'center');
        T('PAGO EM:_____/_____/_________', 258.6, 144.4, 10.25, 'bold');
        T('INFORMAÇÕES COMPLEMENTARES:', 63.9, 167.7, 10.25, 'bold');
        const compl = [v.complementares, paginas > 1 ? `Página ${pg + 1} de ${paginas}.` : ''].filter(Boolean).join(' ');
        if (compl) {
          pdf.setFont('times', 'normal'); pdf.setFontSize(7.5);
          pdf.splitTextToSize(compl, 545.7 - 252).slice(0, 2).forEach((t, k) => pdf.text(t, 252, 166.5 + k * 8));
        }
        // Tabela: uma linha por setor
        const yFim = VALE_FIM_CAB + VALE_LINHAS_POR_PAGINA * VALE_ALT_LINHA;
        pdf.rect(VALE_COLS[0], VALE_TOPO_TABELA, VALE_COLS[7] - VALE_COLS[0], yFim - VALE_TOPO_TABELA);
        VALE_COLS.slice(1, 7).forEach(x => pdf.line(x, VALE_TOPO_TABELA, x, yFim));
        for (let k = 0; k <= VALE_LINHAS_POR_PAGINA; k++) { const y = VALE_FIM_CAB + k * VALE_ALT_LINHA; pdf.line(VALE_COLS[0], y, VALE_COLS[7], y); }
        const cx = k => (VALE_COLS[k] + VALE_COLS[k + 1]) / 2;
        const larg = k => VALE_COLS[k + 1] - VALE_COLS[k] - 4;
        T('ITEM', cx(0), 199.0, 9.25, 'bold', 'center'); T('UF', cx(1), 199.0, 9.25, 'bold', 'center');
        T('QTD.', cx(2), 193.8, 9.25, 'bold', 'center'); T('SOL.', cx(2), 204.2, 9.25, 'bold', 'center');
        T('QTD.', cx(3), 193.8, 9.25, 'bold', 'center'); T('FORN.', cx(3), 204.2, 9.25, 'bold', 'center');
        T('PREÇO', cx(4), 193.8, 9.25, 'bold', 'center'); T('UNITÁRIO', cx(4), 204.2, 9.25, 'bold', 'center');
        T('PREÇO', cx(5), 193.8, 9.25, 'bold', 'center'); T('TOTAL', cx(5), 204.2, 9.25, 'bold', 'center');
        T('OBS.', cx(6), 199.0, 9.25, 'bold', 'center');
        v.linhas.slice(pg * VALE_LINHAS_POR_PAGINA, (pg + 1) * VALE_LINHAS_POR_PAGINA).forEach((l, k) => {
          const y = VALE_FIM_CAB + k * VALE_ALT_LINHA + 10.2;
          T(caber(l.setor, 220), VALE_COLS[0] + 4, y, 8.5, 'normal', 'left', 220);
          T(l.uf || '', cx(1), y, 8, 'normal', 'center', larg(1));
          T(fmtQtd(l.qtdSol), cx(2), y, 8.5, 'normal', 'center', larg(2));
          T(fmtQtd(l.qtdForn), cx(3), y, 8.5, 'normal', 'center', larg(3));
          if (l.obs) T(l.obs, cx(6), y, 6, 'normal', 'center', larg(6));
        });
        // Total (em quantidade fornecida, na unidade do item) — na última página do vale
        const ultima = pg === paginas - 1;
        const yT = yFim, yTb = yT + 28.1;
        pdf.line(291.6, yT, 291.6, yTb); pdf.line(545.7, yT, 545.7, yTb); pdf.line(291.4, yTb, 546.0, yTb);
        pdf.line(427.9, yT, 427.9, yTb); pdf.line(464.3, yT, 464.3, yTb);
        pdf.setLineWidth(0.75); pdf.line(414.2, yT + 22.7, 486.2, yT + 22.7); pdf.setLineWidth(0.5);
        T('TOTAL', 331.2, 599.3, 10.25, 'bold');
        if (ultima) T(qtdUn(v.totalForn, v.unidade), 505.0, 599.0, 10, 'bold', 'center', 76);
        else T('continua', 505.0, 599.0, 8, 'normal', 'center');
        // Assinaturas (iguais ao modelo; o campo PAIOLEIRO recebe quem forneceu)
        const yR = 621.9, yM = 661.5, yB = 684.5;
        pdf.rect(VALE_RODAPE[0], yR, VALE_RODAPE[6] - VALE_RODAPE[0], yB - yR);
        VALE_RODAPE.slice(1, 6).forEach(x => pdf.line(x, yR, x, yB));
        pdf.line(VALE_RODAPE[0], yM, VALE_RODAPE[6], yM);
        const rc = k => (VALE_RODAPE[k] + VALE_RODAPE[k + 1]) / 2;
        T('Assinatura do Encarregado do setor', rc(0), 628.6, 7.25, 'normal', 'center'); T('solicitante:', rc(0), 636.7, 7.25, 'normal', 'center');
        T('Assinatura do Chefe de', rc(1), 628.6, 7.25, 'normal', 'center'); T('Dep. do setor solicitante:', rc(1), 636.7, 7.25, 'normal', 'center');
        T('FIEL DE MUNICIAMENTO', 252.8, 627.7, 6.25);
        T('Autorizado por:', 331.6, 628.6, 7.25);
        T('ENTREGUE POR:', 416.6, 628.6, 7.25);
        T('RECEBIDO POR:', 486.8, 628.6, 7.25);
        T('JOSÉ SAMUEL CALDAS ALVES', rc(2), 666.4, 5.25, 'normal', 'center');
        T('Segundo-Sargento  (CO)', rc(2), 672.1, 5.25, 'normal', 'center');
        T('Fiel de Municiamento', rc(2), 677.9, 5.25, 'normal', 'center');
        T('MARIANA CARVALHO TARANTO', rc(3), 665.5, 4.25, 'normal', 'center');
        T('Segundo-Tenente (RM2-S)', rc(3), 671.0, 5.25, 'normal', 'center');
        T('Gestor de Municiamento', rc(3), 676.7, 5.25, 'normal', 'center');
        // Imagens das assinaturas: logo abaixo do título de cada campo, no espaço acima do nome
        desenharAssinatura(pdf, assinaturas.fiel, VALE_RODAPE[2] + 2.5, 630.6, VALE_RODAPE[3] - VALE_RODAPE[2] - 5, 30.0);
        desenharAssinatura(pdf, assinaturas.autorizado, VALE_RODAPE[3] + 2.5, 631.2, VALE_RODAPE[4] - VALE_RODAPE[3] - 5, 29.4);
        T('PAIOLEIRO:', rc(4), 666.4, 5.25, 'normal', 'center');
        const paiol = somentePaioleiros(v.paioleiros);
        if (paiol.length) T(paiol.join(', '), rc(4), 674.5, 5.25, 'normal', 'center', VALE_RODAPE[5] - VALE_RODAPE[4] - 4);
        T('POSTO/GRAD/NOME', rc(5), 666.4, 5.25, 'normal', 'center');
      }
    }
    return pdf;
  }

  // Coloca a imagem centralizada dentro da caixa (x, y, larg, alt), mantendo a proporção.
  function desenharAssinatura(pdf, a, x, y, larg, alt) {
    if (!a || !a.imagem || !a.largura || !a.altura) return;
    const k = Math.min(larg / a.largura, alt / a.altura);
    const w = a.largura * k, h = a.altura * k;
    try { pdf.addImage(a.imagem, 'PNG', x + (larg - w) / 2, y + (alt - h) / 2, w, h); } catch (e) { /* imagem inválida: segue sem ela */ }
  }

  async function carregarAssinaturas() {
    const r = {};
    await Promise.all(CAMPOS_ASSINATURA.map(async c => {
      try { const s = await getDoc(doc(db, 'assinaturas', c.id)); if (s.exists()) r[c.id] = s.data(); } catch (e) { /* sem permissão ou sem assinatura */ }
    }));
    return r;
  }

  async function baixarValePDF(vales) {
    const [JsPDF, assinaturas] = await Promise.all([carregarJsPDF(), carregarAssinaturas(), conhecerFornecedores()]);
    const pdf = desenharValePDF(JsPDF, vales, assinaturas);
    const nome = vales.length === 1 ? vales[0].itemNome.replace(/[^\wÀ-ÿ-]+/g, '_') : 'todos_os_itens';
    pdf.save(`Vale_Generos_CN-42_${fmtData(vales[0].data).replace(/\//g, '-')}_${nome}.pdf`);
    return pdf;
  }

  // ---------- Tela "Gerar Vale de Gêneros" (Paioleiro e Administrador) ----------
  function painelVales(alvo, ctx) {
    const hoje = hojeISO();
    const setoresComForn = dt => [...new Set(fornecimentosDaData(dt).map(s => s.modalidadeId))]
      .map(id => ({ id, nome: nomeSetor(id) })).sort((x, y) => ordemNatural(x.nome, y.nome));
    const vales = (dados.vales || []).slice().sort((x, y) => (y.data || '').localeCompare(x.data || '') || ordemNatural(x.itemNome || '', y.itemNome || ''));
    const desenhar = (dt, setorSel, itemSel, compl) => {
      const itens = itensFornecidosNaData(dt, setorSel);
      if (itemSel && !itens.some(i => i.id === itemSel)) itemSel = '';
      const alvoItens = itemSel ? itens.filter(i => i.id === itemSel) : itens;
      const conteudos = alvoItens.map(i => montarVale(dt, i.id, setorSel, compl)).filter(v => v.linhas.length);
      alvo.innerHTML = `
      <section class="card">
        <h2>📄 Vale Extraordinário de Gêneros (CN-42)</h2>
        <p class="muted small" style="margin-top:-.3rem">Um vale por item, com os fornecimentos efetivamente realizados na data (somente "Fornecido", com as quantidades fornecidas). A tabela lista os setores e o total do item, em quantidade, aparece embaixo. O estoque e as solicitações não são alterados.</p>
        <div class="grade">
          <label>Data do fornecimento<input type="date" id="valeData" value="${esc(dt)}" max="${hoje}"></label>
          <label>Item
            <select id="valeItem">
              ${itens.length ? `<option value="">Todos os itens (um vale para cada)</option>` : '<option value="">Nenhum item fornecido nesta data</option>'}
              ${itens.map(i => `<option value="${i.id}" ${i.id === itemSel ? 'selected' : ''}>${esc(i.nome)} (${esc(i.unidade)})</option>`).join('')}
            </select></label>
          <label>Setor
            <select id="valeSetor"><option value="">Todos os setores da data</option>
              ${setoresComForn(dt).map(s => `<option value="${s.id}" ${s.id === setorSel ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}
            </select></label>
        </div>
        <label>Informações complementares (opcional)<input id="valeCompl" maxlength="300" value="${esc(compl || '')}" placeholder="Texto que aparecerá no campo INFORMAÇÕES COMPLEMENTARES"></label>
        <div class="resumo-vale">
          ${conteudos.length
            ? conteudos.map(v => `<strong>${esc(v.itemNome)}</strong>: ${plural(v.linhas.length, 'setor', 'setores')} (${esc(v.setoresNomes.join(', '))}) · total fornecido <strong>${esc(qtdUn(v.totalForn, v.unidade))}</strong>`).join('<br>')
            : 'Nenhum fornecimento (status "Fornecido") nesta data.'}
        </div>
        <div class="erro" id="erroVale"></div>
        <div class="acoes"><button class="btn primario" id="btnGerarVale" ${conteudos.length ? '' : 'disabled'}>Gerar Vale de Gêneros (PDF)${conteudos.length > 1 ? ` — ${conteudos.length} vales` : ''}</button></div>
      </section>
      <section class="card">
        <h2>Vales gerados</h2>
        ${vales.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Data</th><th>Item</th><th>Setores</th><th class="num">Total fornecido</th><th>Gerado por</th><th></th></tr></thead>
          <tbody>${vales.map(x => `<tr>
            <td>${esc(fmtData(x.data))}</td><td><strong>${esc(x.itemNome || '—')}</strong></td><td>${esc((x.setoresNomes || []).join(', '))}</td>
            <td class="num">${esc(qtdUn(x.totalForn || 0, x.unidade))}</td><td>${esc(x.geradoPorNome || '—')}<div class="small muted">${fmtDataHora(x.atualizadoEm)}</div></td>
            <td class="num"><button class="btn secundario pequeno" data-baixar-vale="${x.id}">Baixar PDF</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum vale gerado ainda.</p>'}
      </section>`;
      const erro = msg => { $('erroVale').textContent = msg; };
      const atual = () => [$('valeSetor').value, $('valeItem').value, $('valeCompl').value];
      $('valeData').onchange = () => { alvo.dataset.valeData = $('valeData').value; desenhar($('valeData').value, '', '', $('valeCompl').value); };
      $('valeSetor').onchange = () => desenhar(dt, ...atual());
      $('valeItem').onchange = () => desenhar(dt, ...atual());
      $('btnGerarVale').onclick = () => comBotao($('btnGerarVale'), async () => {
        try {
          const [setor, itemId, compl2] = atual();
          const alvoIds = itemId ? [itemId] : itensFornecidosNaData(dt, setor).map(i => i.id);
          const lista = alvoIds.map(id => montarVale(dt, id, setor, compl2)).filter(v => v.linhas.length);
          if (!lista.length) return erro('Nenhum fornecimento nesta data.');
          const registrados = [];
          for (const v of lista) registrados.push(await registrarVale(v));
          await baixarValePDF(registrados);
          ctx.recarregar(`${plural(registrados.length, 'Vale de Gêneros gerado', 'Vales de Gêneros gerados')} para ${fmtData(dt)}.`);
        } catch (e) { erro(e.message && !e.code ? e.message : 'Não foi possível gerar o vale: ' + msgErro(e)); }
      });
      alvo.querySelectorAll('[data-baixar-vale]').forEach(b => b.onclick = () => comBotao(b, async () => {
        const x = vales.find(y => y.id === b.dataset.baixarVale);
        try { await baixarValePDF([x]); } catch (e) { erro(e.message || msgErro(e)); }
      }));
    };
    conhecerFornecedores().finally(() => desenhar(alvo.dataset.valeData || hoje, '', '', ''));
  }

  /* ================= Assinaturas do Vale (imagens) ================= */
  // Guardadas no próprio Firestore (coleção "assinaturas"), sem Firebase Storage,
  // para não depender de recurso pago. A imagem é tratada no navegador:
  // o fundo do papel fica transparente e a assinatura é recortada e reduzida.
  const CAMPOS_ASSINATURA = [
    { id: 'fiel', titulo: 'Fiel de Municiamento', ajuda: 'Aparece no campo FIEL DE MUNICIAMENTO do vale.' },
    { id: 'autorizado', titulo: 'Autorizado por', ajuda: 'Aparece no campo "Autorizado por:" do vale.' }
  ];
  const ASSIN_MAX_LARG = 600, ASSIN_MAX_ALT = 300, ASSIN_MAX_BYTES = 600000;

  // Recebe os pixels RGBA e devolve a assinatura recortada com fundo transparente.
  function limparAssinatura(px, w, h) {
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    // Fundo estimado por blocos (compensa sombra e iluminação desigual da foto)
    const tam = Math.max(16, Math.round(Math.max(w, h) / 20));
    const gw = Math.ceil(w / tam), gh = Math.ceil(h / tam), grade = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const hist = new Uint32Array(256); let n = 0;
      for (let y = gy * tam; y < Math.min(h, (gy + 1) * tam); y++) for (let x = gx * tam; x < Math.min(w, (gx + 1) * tam); x++) { hist[lum[y * w + x] | 0]++; n++; }
      let acum = 0, v = 255; const alvo = n * 0.6;            // 60% mais escuros ficam abaixo: o papel domina o bloco
      for (let k = 0; k < 256; k++) { acum += hist[k]; if (acum >= alvo) { v = k; break; } }
      grade[gy * gw + gx] = v;
    }
    const fundo = (x, y) => {                                 // interpolação bilinear entre os blocos
      const fx = Math.min(Math.max(x / tam - 0.5, 0), gw - 1), fy = Math.min(Math.max(y / tam - 0.5, 0), gh - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, gw - 1), y1 = Math.min(y0 + 1, gh - 1), ax = fx - x0, ay = fy - y0;
      const g = (a, b) => grade[b * gw + a];
      return (g(x0, y0) * (1 - ax) + g(x1, y0) * ax) * (1 - ay) + (g(x0, y1) * (1 - ax) + g(x1, y1) * ax) * ay;
    };
    const alfa = new Float32Array(w * h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, a = Math.min(1, Math.max(0, (fundo(x, y) - lum[i] - 18) / 45));
      alfa[i] = a;
      if (a > 0.35) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const pad = Math.round(Math.max(w, h) * 0.01) + 2;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (y + y0) * w + (x + x0), o = (y * cw + x) * 4;
      out[o] = px[i * 4] * 0.6; out[o + 1] = px[i * 4 + 1] * 0.6; out[o + 2] = px[i * 4 + 2] * 0.6;   // tinta um pouco mais forte, mantendo a cor
      out[o + 3] = alfa[i] * 255;
    }
    return { pixels: out, largura: cw, altura: ch };
  }

  function lerImagem(arquivo) {
    return new Promise((ok, falha) => {
      const url = URL.createObjectURL(arquivo), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); falha(new Error('Não foi possível abrir a imagem. Use um arquivo JPG ou PNG.')); };
      img.src = url;
    });
  }

  async function prepararAssinatura(arquivo) {
    if (!arquivo || !/^image\//.test(arquivo.type)) throw new Error('Escolha um arquivo de imagem (JPG ou PNG).');
    const img = await lerImagem(arquivo);
    const red = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * red)), h = Math.max(1, Math.round(img.naturalHeight * red));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); c.drawImage(img, 0, 0, w, h);
    const r = limparAssinatura(c.getImageData(0, 0, w, h).data, w, h);
    if (!r) throw new Error('Não foi possível identificar a assinatura na imagem. Use uma foto nítida, em papel branco.');
    const recorte = document.createElement('canvas'); recorte.width = r.largura; recorte.height = r.altura;
    recorte.getContext('2d').putImageData(new ImageData(r.pixels, r.largura, r.altura), 0, 0);
    for (let fator = 1; fator >= 0.3; fator -= 0.15) {
      const e = Math.min(1, ASSIN_MAX_LARG / r.largura, ASSIN_MAX_ALT / r.altura) * fator;
      const fw = Math.max(1, Math.round(r.largura * e)), fh = Math.max(1, Math.round(r.altura * e));
      const fin = document.createElement('canvas'); fin.width = fw; fin.height = fh;
      const fc = fin.getContext('2d'); fc.imageSmoothingQuality = 'high'; fc.drawImage(recorte, 0, 0, fw, fh);
      const imagem = fin.toDataURL('image/png');
      if (imagem.length <= ASSIN_MAX_BYTES) return { imagem, largura: fw, altura: fh };
    }
    throw new Error('A imagem ficou grande demais. Recorte a foto deixando só a assinatura e tente novamente.');
  }

  // Seção do Administrador (aba "Vales de Gêneros") para cadastrar as imagens.
  async function painelAssinaturas(alvo, ctx) {
    alvo.innerHTML = `<section class="card"><h2>✍️ Assinaturas do Vale</h2><p class="muted">Carregando…</p></section>`;
    const atuais = await carregarAssinaturas();
    const novas = {};
    const desenhar = () => {
      alvo.innerHTML = `
      <section class="card">
        <h2>✍️ Assinaturas do Vale</h2>
        <p class="muted small" style="margin-top:-.3rem">Envie a foto ou o escaneamento de cada assinatura (de preferência em papel branco). O sistema remove o fundo, recorta a assinatura e a imprime em todos os vales gerados, logo abaixo do título do campo.</p>
        <div class="assin-grade">
          ${CAMPOS_ASSINATURA.map(c => {
            const nova = novas[c.id], atual = atuais[c.id], mostra = nova || atual;
            return `<div class="assin-campo">
              <h3>${esc(c.titulo)}</h3>
              <p class="small muted">${esc(c.ajuda)}</p>
              <div class="assin-previa">${mostra ? `<img src="${mostra.imagem}" alt="Assinatura — ${esc(c.titulo)}">` : '<span class="muted small">Nenhuma assinatura cadastrada</span>'}</div>
              ${nova ? '<p class="small"><strong>Prévia da nova imagem</strong> — clique em “Salvar assinatura” para usar.</p>'
                : (atual ? `<p class="small muted">Atualizada por ${esc(atual.atualizadoPorNome || '—')} · ${fmtDataHora(atual.atualizadoEm)}</p>` : '')}
              <label>Imagem da assinatura<input type="file" accept="image/*" data-assin-arquivo="${c.id}"></label>
              <div class="acoes">
                <button class="btn primario" data-assin-salvar="${c.id}" ${nova ? '' : 'disabled'}>Salvar assinatura</button>
                ${atual && !nova ? `<button class="btn secundario" data-assin-remover="${c.id}">Remover</button>` : ''}
                ${nova ? `<button class="btn secundario" data-assin-cancelar="${c.id}">Cancelar</button>` : ''}
              </div>
              <div class="erro" id="erroAssin_${c.id}"></div>
            </div>`;
          }).join('')}
        </div>
      </section>`;
      alvo.querySelectorAll('[data-assin-arquivo]').forEach(inp => inp.onchange = async () => {
        const id = inp.dataset.assinArquivo, erro = $('erroAssin_' + id);
        erro.textContent = 'Processando imagem…';
        try { novas[id] = await prepararAssinatura(inp.files[0]); desenhar(); }
        catch (e) { erro.textContent = e.message || 'Não foi possível processar a imagem.'; inp.value = ''; }
      });
      alvo.querySelectorAll('[data-assin-cancelar]').forEach(b => b.onclick = () => { delete novas[b.dataset.assinCancelar]; desenhar(); });
      alvo.querySelectorAll('[data-assin-salvar]').forEach(b => b.onclick = () => comBotao(b, async () => {
        const id = b.dataset.assinSalvar, n = novas[id];
        try {
          await setDoc(doc(db, 'assinaturas', id), {
            imagem: n.imagem, largura: n.largura, altura: n.altura,
            atualizadoEm: serverTimestamp(), atualizadoPor: perfil.uid, atualizadoPorNome: perfil.nome
          });
          ctx.recarregar(`Assinatura "${CAMPOS_ASSINATURA.find(c => c.id === id).titulo}" salva. Ela será impressa nos próximos vales.`);
        } catch (e) { $('erroAssin_' + id).textContent = 'Não foi possível salvar: ' + msgErro(e); }
      }));
      alvo.querySelectorAll('[data-assin-remover]').forEach(b => b.onclick = () => comBotao(b, async () => {
        const id = b.dataset.assinRemover, c = CAMPOS_ASSINATURA.find(x => x.id === id);
        if (!confirm(`Remover a assinatura "${c.titulo}"? Os próximos vales sairão sem ela.`)) return;
        try { const lote = writeBatch(db); lote.delete(doc(db, 'assinaturas', id)); await lote.commit(); ctx.recarregar(`Assinatura "${c.titulo}" removida.`); }
        catch (e) { $('erroAssin_' + id).textContent = 'Não foi possível remover: ' + msgErro(e); }
      }));
    };
    desenhar();
  }

  /* ================= Paioleiro ================= */
  // Vê apenas solicitações autorizadas ("Pedido Recebido") e as já fornecidas,
  // e só pode marcar "Fornecido" (com baixa no estoque).
  /* ---------- Saldo em Estoque (Paioleiro): somente consulta ---------- */
  // Lê os próprios cadastros de itens no Firebase (coleção "itens"): o campo "saldo"
  // já reflete o estoque inicial, as entradas e as baixas feitas em cada fornecimento.
  // A tela acompanha as alterações em tempo real e não grava nada.
  let pararSaldoFn = null;
  function pararSaldo() { if (pararSaldoFn) { try { pararSaldoFn(); } catch (e) { /* já encerrado */ } pararSaldoFn = null; } }
  function painelSaldo(alvo) {
    pararSaldo();
    const filtro = { texto: '', unidade: '', situacao: '' };
    let itens = null, falha = '';
    const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const desenharLinhas = () => {
      const corpo = $('saldoCorpo'); if (!corpo) return;
      if (falha) { $('saldoInfo').innerHTML = `<span class="erro">${esc(falha)}</span>`; corpo.innerHTML = ''; return; }
      if (!itens) { $('saldoInfo').textContent = 'Carregando saldos…'; return; }
      const sel = $('saldoUnidade'), unidades = [...new Set(itens.map(i => i.unidade).filter(Boolean))].sort(ordemNatural);
      const atualU = filtro.unidade && unidades.includes(filtro.unidade) ? filtro.unidade : '';
      sel.innerHTML = '<option value="">Todas</option>' + unidades.map(u => `<option value="${esc(u)}" ${u === atualU ? 'selected' : ''}>${esc(u)}</option>`).join('');
      filtro.unidade = atualU;
      const q = norm(filtro.texto);
      const vis = itens.filter(i => (!q || norm(i.nome).includes(q))
        && (!filtro.unidade || i.unidade === filtro.unidade)
        && (!filtro.situacao || (filtro.situacao === 'com' ? i.saldo > EPS : !(i.saldo > EPS))));
      const semSaldo = itens.filter(i => !(i.saldo > EPS)).length;
      $('saldoInfo').textContent = `${plural(vis.length, 'item', 'itens')}${vis.length !== itens.length ? ` de ${itens.length}` : ''} · ${plural(semSaldo, 'sem saldo', 'sem saldo')}`;
      corpo.innerHTML = vis.length ? vis.map(i => {
        const zero = !(i.saldo > EPS);
        return `<tr><td><strong>${esc(i.nome)}</strong>${i.ativo === false ? ' <span class="status inativo">Inativo</span>' : ''}</td>
          <td>${esc(i.unidade || '—')}</td>
          <td class="num">${zero ? `<span class="saldo-zero">${fmtQtd(i.saldo)}</span> <span class="status sem-saldo">Sem saldo</span>` : `<strong>${fmtQtd(i.saldo)}</strong>`}</td></tr>`;
      }).join('') : '<tr><td colspan="3" class="muted">Nenhum item encontrado com esses filtros.</td></tr>';
    };
    alvo.innerHTML = `
      <section class="card">
        <h2 class="titulo-saldo">📦 Saldo em Estoque <span class="ao-vivo" id="saldoAoVivo">Atualizado em tempo real</span></h2>
        <p class="muted small" style="margin-top:-.3rem">Somente consulta. Mostra o saldo cadastrado de cada item, já considerando o estoque inicial, as entradas e as baixas feitas ao confirmar cada fornecimento.</p>
        <div class="saldo-filtros">
          <label>Pesquisar item<input id="saldoBusca" type="search" placeholder="Digite o nome do item…" autocomplete="off"></label>
          <label>Unidade<select id="saldoUnidade"><option value="">Todas</option></select></label>
          <label>Situação<select id="saldoSituacao"><option value="">Todos os itens</option><option value="com">Com saldo</option><option value="sem">Sem saldo</option></select></label>
        </div>
        <p class="small muted" id="saldoInfo" style="margin:.2rem 0 .6rem">Carregando saldos…</p>
        <div class="tabela-wrap"><table class="tabela-saldo">
          <thead><tr><th>Item</th><th>Unidade</th><th class="num">Saldo cadastrado</th></tr></thead>
          <tbody id="saldoCorpo"></tbody></table></div>
      </section>`;
    $('saldoBusca').oninput = () => { filtro.texto = $('saldoBusca').value; desenharLinhas(); };
    $('saldoUnidade').onchange = () => { filtro.unidade = $('saldoUnidade').value; desenharLinhas(); };
    $('saldoSituacao').onchange = () => { filtro.situacao = $('saldoSituacao').value; desenharLinhas(); };
    const receber = docs => { itens = docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ordemNatural(a.nome, b.nome)); falha = ''; desenharLinhas(); };
    if (typeof onSnapshot === 'function') {
      pararSaldoFn = onSnapshot(collection(db, 'itens'), snap => receber(snap.docs),
        e => { falha = 'Não foi possível acompanhar os saldos: ' + msgErro(e); const v = $('saldoAoVivo'); if (v) v.hidden = true; desenharLinhas(); });
    } else {
      getDocs(collection(db, 'itens')).then(snap => receber(snap.docs)).catch(e => { falha = 'Não foi possível carregar os saldos: ' + msgErro(e); desenharLinhas(); });
    }
  }

  async function telaPaioleiro(mensagem) {
    pararSaldo();
    app.innerHTML = CARREGANDO;
    try {
      const [modalidades, eventos, solicitacoes, itens, vales] = await Promise.all([
        lista('modalidades'), lista('eventos').catch(() => []),
        listaConsulta(query(collection(db, 'solicitacoes'), where('status', 'in', ['recebido', 'fornecido']))),
        lista('itens').catch(() => []), lista('vales').catch(() => [])
      ]);
      dados = { ...vazio(), modalidades: ordenarModalidades(modalidades), eventos, solicitacoes, itens, vales };
    } catch (e) {
      return telaFalha('Paioleiro', e, () => telaPaioleiro());
    }
    app.innerHTML = cabecalho('Paioleiro', true) + `
      <main class="conteudo">
        ${mensagem ? `<div class="aviso">${esc(mensagem)}</div>` : ''}
        <div class="acoes" style="margin:0 0 1rem"><button class="btn primario" id="btnAbrirVale">📄 Gerar Vale de Gêneros</button><button class="btn primario" id="btnAbrirSaldo">📦 Saldo em Estoque</button></div>
        <div id="areaVale" hidden></div>
        <div id="areaSaldo" hidden></div>
        <div id="painel"></div>
      </main>`;
    ligarSair();
    $('btnAtualizar').onclick = () => telaPaioleiro();
    $('btnAbrirVale').onclick = () => {
      const area = $('areaVale'); area.hidden = !area.hidden;
      $('btnAbrirVale').textContent = area.hidden ? '📄 Gerar Vale de Gêneros' : 'Fechar Vale de Gêneros';
      if (!area.hidden) painelVales(area, { recarregar: msg => telaPaioleiro(msg) });
    };
    $('btnAbrirSaldo').onclick = () => {
      const area = $('areaSaldo'); area.hidden = !area.hidden;
      $('btnAbrirSaldo').textContent = area.hidden ? '📦 Saldo em Estoque' : 'Fechar Saldo em Estoque';
      $('btnAbrirSaldo').classList.toggle('ativa-menu', !area.hidden);
      if (area.hidden) { pararSaldo(); area.innerHTML = ''; } else painelSaldo(area);
    };
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
          return `<div style="margin-top:.35rem"><button class="btn primario pequeno" data-fornecer="${s.id}">FORNECER</button></div>`;
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

      const recolhivel = !paioleiro;                  // minimizar/expandir: área do Administrador
      const fechado = dt => recolhivel && gruposRecolhidos.has(dt);
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
          ? 'Aqui aparecem as solicitações autorizadas pelo Administrador ("Pedido Recebido"). Ao entregar o pedido, clique em "FORNECER" e confirme: a baixa no estoque é feita nesse momento e o status passa para "Fornecido".'
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
        ${paioleiro ? '' : `<div class="barra-lote" id="barraSol" hidden><span id="qtdSol"></span>
          <button class="btn perigo-cheio pequeno" id="btnExcluirSol">Excluir histórico</button></div>`}
        ${porData.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Setor</th><th class="num">Quantidade</th><th>Itens</th><th>Responsável</th><th>Registrada em</th><th>Status</th></tr></thead>
          <tbody>${porData.map(({ dt, lista }) => `
            <tr class="grupo-data${fechado(dt) ? ' recolhido' : ''}"><td colspan="6">
              <div class="grupo-titulo">${recolhivel ? `<button type="button" class="btn-grupo" data-alternar-grupo="${dt}" aria-expanded="${!fechado(dt)}" title="${fechado(dt) ? 'Expandir' : 'Minimizar'} as solicitações desta data">${fechado(dt) ? '▼ Expandir' : '▲ Minimizar'}</button>` : ''}📅 ${esc(fmtDataSemana(dt))}${dt === hoje ? ' <span class="status recebido">hoje</span>' : ''}
                <span class="grupo-info">Retirada ${RETIRADA_TEXTO} · ${plural(lista.length, 'solicitação', 'solicitações')} · Quantidade total: ${fmtQtd(soma(lista))}</span></div>
              <div class="grupo-itens">Itens a preparar: ${itensAPreparar(lista)}</div>
            </td></tr>
            ${lista.map(s => `<tr class="${classeLinha(s)}" data-grupo-de="${dt}" ${fechado(dt) ? 'hidden' : ''}>
              <td>${!paioleiro && grupoDe(s) === 'fornecidos' ? `<input type="checkbox" class="caixa" data-sel-sol="${s.id}" aria-label="Selecionar para excluir do histórico" style="margin-right:.35rem">` : ''}<strong>${esc(nomeSetor(s.modalidadeId))}</strong></td>
              <td class="num">${fmtQtd(s.quantidade)}</td>
              <td>${listaItensHtml(s)}</td>
              <td>${esc(s.usuarioNome || '—')}</td>
              <td>${fmtDataHora(s.criadoEm)}</td>
              <td>${seloStatus(s)}${historicoStatus(s)}${acoes(s)}</td>
            </tr>${temAlteracoes(s) ? `<tr class="linha-registro" data-grupo-de="${dt}" ${fechado(dt) ? 'hidden' : ''}><td colspan="6">
              <div class="registro-titulo">Registro de Alterações na Quantidade</div>
              ${tabelaRegistro(s.alteracoes, s.fornecidoPorNome, fmtDataHora(s.fornecidoEm))}
            </td></tr>` : ''}`).join('')}`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma solicitação neste filtro.</p>'}
      </section>`;

      const erro = msg => { $('erroAtend').textContent = msg; };
      const resumoTexto = s =>
        `Setor: ${nomeSetor(s.modalidadeId)}\n` +
        `Data da retirada: ${fmtDataSemana(dataDe(s))}\n` +
        `Retirada: ${textoRetirada(s)}\n` +
        `Quantidade: ${fmtQtd(s.quantidade)}`;

      if (!paioleiro) {
        const solMarcadas = () => [...p.querySelectorAll('[data-sel-sol]:checked')].map(c => c.dataset.selSol);
        p.querySelectorAll('[data-sel-sol]').forEach(c => c.onchange = () => {
          const n = solMarcadas().length; $('barraSol').hidden = !n; $('qtdSol').textContent = plural(n, 'solicitação concluída selecionada', 'solicitações concluídas selecionadas');
        });
        $('btnExcluirSol').onclick = () => confirmarExclusaoHistorico(p, {
          colecao: 'solicitacoes', nomeHistorico: 'Solicitações e fornecimentos', aba: 'solicitacoes',
          registros: solMarcadas().map(id => { const s = dados.solicitacoes.find(x => x.id === id);
            return { id, descricao: `${fmtData(dataDe(s))} · ${nomeSetor(s.modalidadeId)} · ${s.usuarioNome || '—'} · quantidade ${fmtQtd(s.quantidade)}${temAlteracoes(s) ? ' · com registro de alterações' : ''}` }; })
        });
      }
      // Minimizar / expandir cada data, sem afetar as demais (o estado vale durante a sessão)
      p.querySelectorAll('[data-alternar-grupo]').forEach(b => b.onclick = () => {
        const dt = b.dataset.alternarGrupo, fechar = !gruposRecolhidos.has(dt);
        if (fechar) gruposRecolhidos.add(dt); else gruposRecolhidos.delete(dt);
        p.querySelectorAll(`tr[data-grupo-de="${dt}"]`).forEach(tr => { tr.hidden = fechar; });
        b.closest('tr').classList.toggle('recolhido', fechar);
        b.setAttribute('aria-expanded', String(!fechar));
        b.title = (fechar ? 'Expandir' : 'Minimizar') + ' as solicitações desta data';
        b.textContent = fechar ? '▼ Expandir' : '▲ Minimizar';
      });
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
            <dt>Setor</dt><dd>${esc(nomeSetor(s.modalidadeId))}</dd>
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
              <td class="num"><input type="text" inputmode="decimal" data-forn="${i.id}" value="${editavel(i.quantidade)}" aria-label="Quantidade fornecida de ${esc(i.nome)}" style="max-width:110px;margin-left:auto"></td>
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
            const f = paraNumero(document.querySelector(`[data-forn="${i.id}"]`).value);
            const just = document.querySelector(`[data-just="${i.id}"]`).value.trim().slice(0, 300);
            if (f == null || Number.isNaN(f) || f < 0) { erros.push(`${i.nome}: informe a quantidade fornecida (zero ou mais; ${DICA_DECIMAL}).`); continue; }
            if (maior(f, i.quantidade)) { erros.push(`${i.nome}: a quantidade fornecida (${qtdUn(f, i.unidade)}) não pode ser maior que a aprovada (${qtdUn(i.quantidade, i.unidade)}).`); continue; }
            fornecidos[i.id] = f;
            if (maior(i.quantidade, f))
              alteracoes[i.id] = { nome: i.nome, unidade: i.unidade, aprovada: i.quantidade, fornecida: f, diferenca: arred(i.quantidade - f), justificativa: just };
            else fornecidos[i.id] = i.quantidade; // igual ao aprovado (sem redução)
          }
          if (!erros.length && Object.values(fornecidos).every(f => !(f > EPS)))
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
            return `• ${i.nome}: fornecido ${qtdUn(f, i.unidade)}${maior(i.quantidade, f) ? ` (aprovado ${qtdUn(i.quantidade, i.unidade)}; redução de ${qtdUn(i.quantidade - f, i.unidade)})` : ''}`;
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
                  if (f == null || maior(f, i.quantidade)) faltas.push(`${i.nome}: quantidade fornecida inválida.`);
                  else if (!it) faltas.push(`${i.nome}: item não encontrado no cadastro.`);
                  else if (maior(f, it.saldo))
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

    /* ---- Histórico de Exclusões (aberto pelo ícone) ---- */
    historico(p) {
      const f = filtroHistorico;
      const todos = exclusoesNorm().sort((a, b) => ms(b.excluidoEm) - ms(a.excluidoEm));
      const admins = [...new Set(todos.map(x => x.porNome).filter(Boolean))].sort();
      const diaDe = ts => { if (!ts || !ts.toMillis) return ''; const b = new Date(ts.toMillis() - FUSO_BRASILIA_MS); return isoData(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate()); };
      const vis = todos.filter(x => (!f.tipo || x.tipo === f.tipo) && (!f.admin || x.porNome === f.admin)
        && (!f.de || diaDe(x.excluidoEm) >= f.de) && (!f.ate || diaDe(x.excluidoEm) <= f.ate));
      const aud = (dados.auditoria || []).slice().sort((a, b) => ms(b.em) - ms(a.em));

      p.innerHTML = `
      <section class="card">
        <h2>🗂 Histórico de Exclusões</h2>
        <p class="muted small" style="margin-top:-.3rem">Registros de setores, usuários, itens e históricos excluídos. Ficam guardados no Firebase mesmo depois que o cadastro original deixa de existir.</p>
        <div class="grade filtros-hist">
          <label>Tipo de registro
            <select id="fhTipo"><option value="">Todos</option>
              ${Object.entries(TIPOS_EXCLUSAO).map(([k, t]) => `<option value="${k}" ${f.tipo === k ? 'selected' : ''}>${t}</option>`).join('')}
            </select></label>
          <label>De<input type="date" id="fhDe" value="${esc(f.de)}"></label>
          <label>Até<input type="date" id="fhAte" value="${esc(f.ate)}"></label>
          <label>Administrador
            <select id="fhAdmin"><option value="">Todos</option>
              ${admins.map(a => `<option ${f.admin === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
            </select></label>
        </div>
        <div class="acoes" style="margin:-.3rem 0 .8rem"><button class="btn secundario pequeno" id="fhLimpar">Limpar filtros</button></div>
        <div class="erro" id="erroHist"></div>
        ${vis.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th style="width:2.2rem"><input type="checkbox" class="caixa" id="fhTodos" aria-label="Selecionar todos"></th>
            <th>Tipo</th><th>Nome e identificação</th><th>Data e horário</th><th>Administrador</th><th>Operação</th><th>Resultado</th></tr></thead>
          <tbody>${vis.map(x => `<tr class="${x.resultado === 'falha' ? 'linha-falha' : ''}">
            <td><input type="checkbox" class="caixa" data-sel-hist="${x.id}" aria-label="Selecionar registro"></td>
            <td><span class="status ativo">${TIPOS_EXCLUSAO[x.tipo] || esc(x.tipo)}</span></td>
            <td><strong>${esc(x.nome)}</strong>${x.identificacao ? `<div class="small muted">${esc(x.identificacao)}${x.setorId && x.tipo === 'responsavel' ? ' · setor ' + esc(nomeSetor(x.setorId)) : ''}</div>` : ''}
              ${x.detalhe ? `<div class="small muted">${esc(x.detalhe)}</div>` : ''}</td>
            <td>${fmtDataHora(x.excluidoEm)}</td>
            <td>${esc(x.porNome || '—')}</td>
            <td>${x.operacao === 'lote' ? 'Em lote' : 'Individual'}</td>
            <td>${x.resultado === 'falha' ? '<span class="status pendente">Com falha</span>' : '<span class="status atendido">Concluída</span>'}</td>
          </tr>`).join('')}</tbody></table></div>
          <div class="barra-lote" id="barraHist" hidden><span id="qtdHist"></span>
            <button class="btn perigo-cheio pequeno" id="btnExcluirHist">Excluir histórico</button></div>`
        : '<p class="muted">Nenhum registro de exclusão' + (todos.length ? ' com estes filtros' : '') + '.</p>'}
      </section>
      <section class="card">
        <h2>Registro administrativo de exclusões de histórico</h2>
        <p class="muted small" style="margin-top:-.3rem">Rastreabilidade: cada vez que um histórico é apagado, fica registrado aqui quem apagou, quando e o quê. Este registro não pode ser apagado.</p>
        ${aud.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Data e horário</th><th>Administrador</th><th>Histórico</th><th class="num">Registros</th><th>Descrição</th></tr></thead>
          <tbody>${aud.map(a => `<tr><td>${fmtDataHora(a.em)}</td><td>${esc(a.porNome || '—')}</td><td>${esc(a.nomeHistorico || a.colecao)}</td>
            <td class="num">${a.quantidade}</td><td class="small">${esc(a.descricao)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Nenhum histórico foi apagado até agora.</p>'}
      </section>`;

      const refazer = () => PAINEIS.historico(p);
      $('fhTipo').onchange = () => { f.tipo = $('fhTipo').value; refazer(); };
      $('fhAdmin').onchange = () => { f.admin = $('fhAdmin').value; refazer(); };
      $('fhDe').onchange = () => { f.de = $('fhDe').value; refazer(); };
      $('fhAte').onchange = () => { f.ate = $('fhAte').value; refazer(); };
      $('fhLimpar').onclick = () => { Object.assign(f, { tipo: '', de: '', ate: '', admin: '' }); refazer(); };
      if (!vis.length) return;
      const marcados = () => [...p.querySelectorAll('[data-sel-hist]:checked')].map(c => c.dataset.selHist);
      const barra = () => { const n = marcados().length; $('barraHist').hidden = !n; $('qtdHist').textContent = plural(n, 'registro selecionado', 'registros selecionados'); };
      p.querySelectorAll('[data-sel-hist]').forEach(c => c.onchange = barra);
      $('fhTodos').onchange = () => { p.querySelectorAll('[data-sel-hist]').forEach(c => { c.checked = $('fhTodos').checked; }); barra(); };
      $('btnExcluirHist').onclick = () => confirmarExclusaoHistorico(p, {
        colecao: 'exclusoes', nomeHistorico: 'Histórico de Exclusões', aba: 'historico',
        registros: marcados().map(id => { const x = vis.find(y => y.id === id);
          return { id, descricao: `${TIPOS_EXCLUSAO[x.tipo] || x.tipo} · ${x.nome}${x.identificacao ? ' (' + x.identificacao + ')' : ''} · ${fmtDataHora(x.excluidoEm)} · por ${x.porNome || '—'}` }; })
      });
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
          id: m.id, quando: m.criadoEm, itemNome: m.itemNome, tipo: m.tipo === 'inicial' ? 'Estoque inicial' : 'Entrada',
          quantidade: m.quantidade, unidade: unidadeDoItem(m.itemId), origem: m.porNome || '—', saida: false
        })),
        ...dados.solicitacoes.filter(estoqueBaixado).flatMap(s => itensDaSolicitacao(s).map(i => ({
          quando: dataDaBaixa(s), itemNome: i.nome, tipo: 'Saída', quantidade: qtdFornecida(s, i), unidade: i.unidade,
          origem: `Fornecido · ${nomeSetor(s.modalidadeId)}${s.fornecidoPorNome ? ' · por ' + s.fornecidoPorNome : ''}` +
            (Math.abs(qtdFornecida(s, i) - i.quantidade) > EPS ? ` · aprovado ${qtdUn(i.quantidade, i.unidade)}, reduzido em ${qtdUn(i.quantidade - qtdFornecida(s, i), i.unidade)}` : ''),
          saida: true
        })).filter(m => m.quantidade > EPS))
      ].sort((a, b) => ms(b.quando) - ms(a.quando));

      p.innerHTML = `
      <section class="card">
        <h2>${ed ? 'Editar item' : 'Cadastrar item'}</h2>
        <form id="fItem" novalidate>
          <div class="grade">
            <label>Nome do item<input name="nome" value="${esc(ed?.nome)}"></label>
            <label>Unidade de medida<input name="unidade" list="listaUnidades" value="${esc(ed?.unidade)}" placeholder="un, pct, kg…"></label>
            <label>Estoque inicial<input type="text" inputmode="decimal" placeholder="ex.: 50 ou 12,5" name="inicial" value="${editavel(ed?.estoqueInicial)}" ${temMovimento ? 'readonly' : ''}></label>
          </div>
          <datalist id="listaUnidades">${UNIDADES.map(u => `<option value="${u}">`).join('')}</datalist>
          <p class="muted small" style="margin-top:-.4rem">Aceita números inteiros ou decimais (até 3 casas, ex.: 12,5). Em cada solicitação, o item é descontado pela quantidade efetivamente fornecida.${temMovimento ? ' Este item já tem movimentações; para aumentar o estoque, registre uma entrada.' : ''}</p>
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
            <label>Quantidade de entrada<input type="text" inputmode="decimal" placeholder="ex.: 10 ou 2,5" name="qtd"></label>
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
              ${botaoExcluir(i.id, 'data-excluir-item')}
            </td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum item cadastrado.</p>'}
      </section>

      <section class="card">
        <h2>Movimentações de estoque</h2>
        <p class="muted small" style="margin-top:-.3rem">Marque as entradas e estoques iniciais que deseja apagar do histórico. As saídas fazem parte das solicitações fornecidas e são apagadas junto com elas, na aba Solicitações. Apagar o histórico não altera o saldo dos itens.</p>
        <div class="erro" id="erroMov"></div>
        ${movs.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th style="width:2.2rem"></th><th>Data</th><th>Item</th><th>Tipo</th><th class="num">Quantidade</th><th>Origem</th></tr></thead>
          <tbody>${movs.map(m => `<tr>
            <td>${m.id ? `<input type="checkbox" class="caixa" data-sel-mov="${m.id}" aria-label="Selecionar movimentação">` : ''}</td>
            <td>${fmtDataHora(m.quando)}</td><td>${esc(m.itemNome)}</td><td>${m.tipo}</td>
            <td class="num">${m.saida ? '−' : '+'}${esc(qtdUn(m.quantidade, m.unidade))}</td><td>${esc(m.origem)}</td>
          </tr>`).join('')}</tbody></table></div>
          <div class="acoes" style="margin-top:.6rem"><button class="btn perigo pequeno" id="btnExcluirMov" hidden>Excluir histórico</button></div>` : '<p class="muted">Nenhuma movimentação registrada.</p>'}
      </section>`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.itens(p, b.dataset.edit));
      p.querySelectorAll('[data-excluir-item]').forEach(b => b.onclick = () => confirmarExclusaoItem(p, item(b.dataset.excluirItem)));
      const movsMarcadas = () => [...p.querySelectorAll('[data-sel-mov]:checked')].map(c => c.dataset.selMov);
      p.querySelectorAll('[data-sel-mov]').forEach(c => c.onchange = () => { $('btnExcluirMov').hidden = !movsMarcadas().length; });
      if ($('btnExcluirMov')) $('btnExcluirMov').onclick = () => confirmarExclusaoHistorico(p, {
        colecao: 'movimentos', nomeHistorico: 'Movimentações de estoque', aba: 'itens',
        registros: movsMarcadas().map(id => { const m = dados.movimentos.find(x => x.id === id);
          return { id, descricao: `${fmtDataHora(m.criadoEm)} · ${m.itemNome} · ${m.tipo === 'inicial' ? 'Estoque inicial' : 'Entrada'} +${qtdUn(m.quantidade, unidadeDoItem(m.itemId))}` }; })
      });
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
        const inicial = paraNumero(f.get('inicial'));
        if (!nome) return erro('Informe o nome do item.');
        if (dados.itens.some(i => i.nome.toLowerCase() === nome.toLowerCase() && i.id !== ed?.id)) return erro('Já existe um item com este nome.');
        if (!unidade) return erro('Informe a unidade de medida.');
        if (inicial == null || Number.isNaN(inicial) || inicial < 0) return erro(`Informe o estoque inicial (zero ou mais; ${DICA_DECIMAL}; até 3 casas decimais).`);

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
        const q = paraNumero(f.get('qtd'));
        if (!i) return erro('Selecione o item.');
        if (q == null || Number.isNaN(q) || !(q > EPS)) return erro(`Informe uma quantidade de entrada válida, maior que zero (${DICA_DECIMAL}; até 3 casas decimais).`);
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

    /* ---- Setores e limites (coleção "modalidades" no banco) ---- */
    modalidades(p) {
      p.innerHTML = `<section class="card">
        <h2>Setores e limites</h2>
        <p class="muted small" style="margin-top:-.3rem"><strong>Limite de quantidade por dia</strong>: soma máxima das quantidades de todos os pedidos do setor na mesma data (aceita decimais).
          <strong>Limite de pedidos por dia</strong>: quantas solicitações o setor pode registrar na mesma data (padrão: 1). Os dois limites valem ao mesmo tempo e a contagem recomeça a cada data.</p>
        <form id="fMod" novalidate>
          <div class="tabela-wrap"><table>
            <thead><tr><th>#</th><th>Setor</th><th>Limite de quantidade por dia</th><th>Limite de pedidos por dia</th><th>Responsável</th><th></th></tr></thead>
            <tbody>${dados.modalidades.map((m, i) => {
              const resp = dados.usuarios.find(u => u.modalidadeId === m.id);
              return `<tr>
                <td>${i + 1}</td>
                <td><input name="nome_${m.id}" value="${esc(m.nome)}"></td>
                <td><input type="text" inputmode="decimal" name="lim_${m.id}" value="${editavel(m.limite)}" placeholder="Não definido"></td>
                <td><input type="number" min="1" step="1" inputmode="numeric" name="dia_${m.id}" value="${limiteDia(m)}" aria-label="Limite de pedidos por dia de ${esc(m.nome)}"></td>
                <td>${resp ? esc(resp.nome) : '<span class="muted">—</span>'}</td>
                <td class="num"><button type="button" class="btn perigo pequeno" data-excluir-setor="${m.id}">Excluir</button></td>
              </tr>`;
            }).join('')}</tbody></table></div>
          <div class="erro" id="erroMod" style="margin-top:.8rem"></div>
          <button class="btn primario" type="submit" id="btnMod">Salvar alterações</button>
        </form></section>`;
      p.querySelectorAll('[data-excluir-setor]').forEach(b => b.onclick = () => confirmarExclusaoSetor(p, modalidade(b.dataset.excluirSetor)));

      $('fMod').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const erro = msg => { $('erroMod').textContent = msg; };
        const novos = [];
        for (const m of dados.modalidades) {
          const nome = String(f.get('nome_' + m.id)).trim();
          const limite = paraNumero(f.get('lim_' + m.id));
          const limiteDiario = paraInteiro(f.get('dia_' + m.id));
          if (!nome) return erro('Todos os setores precisam de um nome.');
          if (Number.isNaN(limite)) return erro(`Limite de quantidade por dia inválido para "${nome}" (${DICA_DECIMAL}; até 3 casas decimais).`);
          if (limiteDiario == null || Number.isNaN(limiteDiario) || limiteDiario < 1) return erro(`Limite de pedidos por dia inválido para "${nome}" (número inteiro, 1 ou mais).`);
          novos.push({ m, nome, limite, limiteDiario });
        }
        const nomes = novos.map(n => n.nome.toLowerCase());
        if (new Set(nomes).size !== nomes.length) return erro('Existem setores com nomes repetidos.');
        const alterados = novos.filter(n => n.nome !== n.m.nome || n.limite !== (n.m.limite ?? null) || n.limiteDiario !== limiteDia(n.m) || n.m.limiteDiario == null);
        if (!alterados.length) return erro('Nenhuma alteração para salvar.');
        comBotao($('btnMod'), async () => {
          try {
            const b = writeBatch(db);
            alterados.forEach(n => b.update(doc(db, 'modalidades', n.m.id), { nome: n.nome, limite: n.limite, limiteDiario: n.limiteDiario }));
            await b.commit();
            salvo('modalidades', 'Setores atualizados.');
          } catch (err) { erro(msgErro(err)); }
        });
      };
    },

    /* ---- Vales de Gêneros (CN-42) ---- */
    vales(p) {
      const ctx = { recarregar: msg => telaAdmin('vales', msg, true) };
      p.innerHTML = '<div id="valeGerar"></div><div id="valeAssinaturas"></div>';
      painelVales($('valeGerar'), ctx);
      painelAssinaturas($('valeAssinaturas'), ctx);
    },

    /* ---- Administradores ---- */
    administradores(p) {
      const lst = dados.usuarios.filter(u => u.perfil === 'admin').sort((a, b) => a.nome.localeCompare(b.nome));
      p.innerHTML = `
      <section class="card">
        <h2>Administradores</h2>
        <p class="muted small" style="margin-top:-.3rem">Administradores têm acesso a todas as funções administrativas do sistema: setores e limites, usuários, itens e estoque, solicitações e históricos. As permissões são verificadas pelo Firebase.</p>
        <div class="acoes"><button class="btn primario" id="btnNovoAdmin">Cadastrar Administrador</button></div>
        <form id="fAdmin" novalidate hidden style="margin-top:1rem">
          <div class="grade">
            <label>Nome completo<input name="nome" autocomplete="off"></label>
            <label>E-mail<input type="email" name="email" autocomplete="off"></label>
            <label>Senha<input type="password" name="senha" autocomplete="new-password" placeholder="Mínimo de 6 caracteres"></label>
            <label>Confirmação de senha<input type="password" name="senha2" autocomplete="new-password"></label>
          </div>
          <div class="erro" id="erroAdmin"></div>
          <div class="acoes">
            <button class="btn primario" type="submit" id="btnAdmin">Cadastrar</button>
            <button class="btn secundario" type="button" id="btnCancelarAdmin">Cancelar</button>
          </div>
        </form>
      </section>
      <section class="card">
        <h2>Administradores cadastrados</h2>
        ${lst.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th></th></tr></thead>
          <tbody>${lst.map(u => `<tr>
            <td><strong>${esc(u.nome)}</strong>${u.id === perfil.uid ? ' <span class="status ativo">você</span>' : ''}</td><td>${esc(u.email || '—')}</td><td>Administrador</td>
            <td class="num">${u.id === perfil.uid
              ? '<button class="btn perigo pequeno" disabled title="Você não pode excluir a própria conta">Excluir</button>'
              : lst.length <= 1 ? '<button class="btn perigo pequeno" disabled title="Última conta administrativa">Excluir</button>'
              : botaoExcluir(u.id)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum administrador cadastrado.</p>'}
        <p class="muted small" style="margin-top:.6rem">Não é possível excluir a própria conta nem a última conta administrativa. Os históricos e registros feitos por administradores excluídos são preservados.</p>
      </section>`;

      $('btnNovoAdmin').onclick = () => { $('fAdmin').hidden = false; $('btnNovoAdmin').hidden = true; };
      $('btnCancelarAdmin').onclick = () => PAINEIS.administradores(p);
      ligarExclusaoUsuarios(p, 'administradores');
      $('fAdmin').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const erro = msg => { $('erroAdmin').textContent = msg; };
        const nome = String(f.get('nome')).trim();
        const email = String(f.get('email')).trim();
        const senha = String(f.get('senha')), senha2 = String(f.get('senha2'));
        if (nome.length < 3) return erro('Informe o nome completo.');
        if (!/^\S+@\S+\.\S+$/.test(email)) return erro('Informe um e-mail válido.');
        if (dados.usuarios.some(u => (u.email || '').toLowerCase() === email.toLowerCase())) return erro('Este e-mail já está cadastrado no sistema.');
        if (senha.length < 6) return erro('A senha deve ter pelo menos 6 caracteres.');
        if (senha !== senha2) return erro('A confirmação de senha não confere.');
        comBotao($('btnAdmin'), async () => {
          try {
            const uid = await criarAcesso(email, senha);
            try {
              await setDoc(doc(db, 'usuarios', uid), { nome, email, perfil: 'admin' });
            } catch (err) {
              return erro('O login foi criado, mas o perfil de administrador não foi salvo (' + msgErro(err) + '). Remova o login em Firebase → Authentication → Usuários e tente novamente.');
            }
            salvo('administradores', `Administrador ${nome} cadastrado. Ele já pode entrar com o e-mail ${email}.`);
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
          <thead><tr>${cabecalhoSelecao()}<th>Nome</th><th>Usuário/e-mail</th><th>Perfil</th><th></th></tr></thead>
          <tbody>${lst.map(u => `<tr>
            ${caixaUsuario(u)}<td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>Paioleiro</td>
            <td class="num" style="white-space:nowrap"><button class="btn secundario pequeno" data-edit="${u.id}">Editar</button> ${botaoExcluir(u.id)}</td>
          </tr>`).join('')}</tbody></table></div>${barraLote()}` : '<p class="muted">Nenhum paioleiro cadastrado.</p>'}
      </section>`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.paioleiros(p, b.dataset.edit));
      ligarExclusaoUsuarios(p, 'paioleiros');
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
            <label>Setor
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
          <thead><tr>${cabecalhoSelecao()}<th>Nome</th><th>Usuário/e-mail</th><th>Perfil</th><th>Setor</th><th></th></tr></thead>
          <tbody>${resp.map(u => `<tr>
            ${caixaUsuario(u)}<td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>Responsável</td><td>${esc(nomeSetor(u.modalidadeId))}</td>
            <td class="num" style="white-space:nowrap"><button class="btn secundario pequeno" data-edit="${u.id}">Editar</button> ${botaoExcluir(u.id)}</td>
          </tr>`).join('')}</tbody></table></div>${barraLote()}` : '<p class="muted">Nenhum responsável cadastrado.</p>'}
      </section>`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.responsaveis(p, b.dataset.edit));
      ligarExclusaoUsuarios(p, 'responsaveis');
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
        if (!modId) return erro('Selecione o setor.');
        const ocupante = dados.usuarios.find(u => u.modalidadeId === modId && u.id !== ed?.id);
        if (ocupante) return erro(`O setor selecionado já possui o responsável ${ocupante.nome}.`);

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
