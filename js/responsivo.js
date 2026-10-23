/* Responsividade: rótulos das tabelas (para o modo cartão) e menu lateral no celular. */
(function () {
  const ICONES = { solicitacoes: '📋', itens: '📦', modalidades: '🏷️', responsaveis: '👤', paioleiros: '🚚', administradores: '🛡️', vales: '📄', historico: '🗂' };
  function rotular(raiz) {
    raiz.querySelectorAll('table').forEach(t => {
      const ths = t.tHead ? [...t.tHead.rows[0]?.cells || []] : [];
      if (!ths.length) return;
      const nomes = []; ths.forEach(th => { for (let k = 0; k < (th.colSpan || 1); k++) nomes.push(th.textContent.trim()); });
      [...t.tBodies].forEach(tb => [...tb.rows].forEach(tr => {
        let i = 0;
        [...tr.cells].forEach(td => { if (!td.hasAttribute('data-label') && (td.colSpan || 1) === 1) td.setAttribute('data-label', nomes[i] || ''); i += td.colSpan || 1; });
      }));
    });
  }
  function menu() {
    const nav = document.querySelector('nav.abas'), topo = document.querySelector('header.topo');
    if (!nav || !topo || topo.querySelector('#btnMenu')) return;
    nav.querySelectorAll('button[data-aba]').forEach(b => { const ic = ICONES[b.dataset.aba]; if (ic) { b.dataset.icone = ic; b.textContent = b.textContent.replace(/^🗂\s*/, ''); } });
    const nome = topo.querySelector('.topo-dir > span')?.textContent || '';
    const titulo = document.createElement('div'); titulo.className = 'menu-titulo';
    titulo.innerHTML = '<strong>PEDIDO</strong><small></small>'; titulo.querySelector('small').textContent = nome;
    nav.prepend(titulo);
    const btn = document.createElement('button'); btn.id = 'btnMenu'; btn.type = 'button'; btn.className = 'btn-menu';
    btn.setAttribute('aria-label', 'Abrir menu'); btn.textContent = '☰';
    topo.prepend(btn);
    const fundo = document.createElement('div'); fundo.className = 'menu-fundo'; document.body.appendChild(fundo);
    const atual = nav.querySelector('button.ativa');
    if (atual) { const barra = document.createElement('div'); barra.className = 'aba-atual'; barra.innerHTML = `<b></b>`; barra.querySelector('b').textContent = (atual.dataset.icone || '') + ' ' + atual.textContent.trim(); nav.after(barra); }
    const fechar = () => document.body.classList.remove('menu-aberto');
    btn.onclick = () => document.body.classList.toggle('menu-aberto');
    fundo.onclick = fechar;
    nav.addEventListener('click', e => { if (e.target.closest('button[data-aba]')) fechar(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') fechar(); });
  }
  let pend = false;
  const aplicar = () => { pend = false; document.querySelectorAll('.menu-fundo').forEach((f, i, l) => { if (i < l.length - 1 || !document.querySelector('nav.abas')) f.remove(); }); rotular(document); menu(); if (!document.querySelector('nav.abas')) document.body.classList.remove('menu-aberto'); };
  new MutationObserver(() => { if (!pend) { pend = true; requestAnimationFrame(aplicar); } }).observe(document.body, { childList: true, subtree: true });
  aplicar();
})();
