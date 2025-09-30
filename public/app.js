// public/app.js
(async function(){
  const guildSelect = document.getElementById('guildSelect');
  const channelSelect = document.getElementById('channelSelect');
  const saveSetupBtn = document.getElementById('saveSetupBtn');
  const createDirectBtn = document.getElementById('createDirectBtn');
  const setupsList = document.getElementById('setupsList');
  const extrasList = document.getElementById('extrasList');
  const addExtraBtn = document.getElementById('addExtraBtn');
  const setupNameInput = document.getElementById('setupName');
  const titleInput = document.getElementById('title');
  const durationInput = document.getElementById('duration');
  const winnersInput = document.getElementById('winners');
  const basedInput = document.getElementById('based');
  const clientSeedInput = document.getElementById('clientSeed');
  const giveawaysDiv = document.getElementById('giveaways');

  function api(path, opts) { return fetch(path, opts).then(r => r.json()); }

  // fetch roles for selected guild and return array
  async function fetchRolesForGuild(guildId) {
    try {
      const roles = await api(`/api/guilds/${guildId}/roles`);
      return roles;
    } catch (e) {
      console.warn('Failed to fetch roles', e);
      return [];
    }
  }

  // add extra row with roles options; always fetch roles for current guild
  async function addExtraRow(roleId = '', extra = 0) {
    const guildId = guildSelect.value;
    const roles = guildId ? await fetchRolesForGuild(guildId) : [];
    const row = document.createElement('div');
    row.className = 'extras-row';
    const roleSelect = document.createElement('select');
    const roleOpt = document.createElement('option'); roleOpt.value = ''; roleOpt.textContent = 'Select role'; roleSelect.appendChild(roleOpt);
    roles.forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = `${r.name} (${r.id})`; if (r.id === roleId) o.selected = true; roleSelect.appendChild(o); });
    const extraInput = document.createElement('input'); extraInput.type = 'number'; extraInput.value = extra; extraInput.placeholder = 'extra (number)';
    const del = document.createElement('button'); del.textContent = 'Remove'; del.style.background = 'transparent'; del.style.border = '1px solid rgba(255,255,255,0.03)'; del.onclick = ()=>row.remove();
    row.appendChild(roleSelect); row.appendChild(extraInput); row.appendChild(del);
    extrasList.appendChild(row);
    return row;
  }

  addExtraBtn.addEventListener('click', ()=> addExtraRow());

  async function loadGuilds() {
    guildSelect.innerHTML = '<option>Loading...</option>';
    try {
      const gs = await api('/api/guilds');
      guildSelect.innerHTML = '';
      gs.forEach(g => { const o = document.createElement('option'); o.value = g.id; o.textContent = `${g.name} (${g.id})`; guildSelect.appendChild(o); });
      if (gs.length) loadChannelsAndRoles(gs[0].id);
    } catch (err) {
      guildSelect.innerHTML = '<option>Error fetching guilds</option>';
    }
  }

  async function loadChannelsAndRoles(guildId) {
    channelSelect.innerHTML = '<option>Loading...</option>';
    try {
      const chs = await api(`/api/guilds/${guildId}/channels`);
      channelSelect.innerHTML = '';
      chs.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.name} (${c.id})`; channelSelect.appendChild(o); });
    } catch(e){ channelSelect.innerHTML = '<option>Error</option>'; }

    // refresh each extras-row select options
    const roles = await fetchRolesForGuild(guildId);
    const existing = Array.from(extrasList.querySelectorAll('.extras-row'));
    if (existing.length === 0) await addExtraRow();
    else {
      existing.forEach(row => {
        const sel = row.querySelector('select');
        const prevVal = sel.value;
        sel.innerHTML = '';
        const blank = document.createElement('option'); blank.value=''; blank.textContent='Select role'; sel.appendChild(blank);
        roles.forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = `${r.name} (${r.id})`; if (r.id===prevVal) o.selected = true; sel.appendChild(o); });
      });
    }
  }

  guildSelect.addEventListener('change', (e)=> loadChannelsAndRoles(e.target.value));

  function collectFormSetup() {
    const title = titleInput.value;
    const guildId = guildSelect.value;
    const channelId = channelSelect.value;
    const basedAmount = Number(basedInput.value || 1);
    const durationMinutes = Number(durationInput.value || 1);
    const winners = Number(winnersInput.value || 1);
    // clientSeed stored but note server will ignore and always fetch TRX block on roll
    const clientSeed = clientSeedInput.value || null;
    const extras = Array.from(extrasList.querySelectorAll('.extras-row')).map(r=>{
      const sel = r.querySelector('select'); const inp = r.querySelector('input');
      return { roleId: sel.value, extra: Number(inp.value || 0) };
    }).filter(e => e.roleId);
    return { title, guildId, channelId, basedAmount, durationMinutes, winners, extras, clientSeed };
  }

  saveSetupBtn.addEventListener('click', async ()=>{
    const name = setupNameInput.value.trim();
    if (!name) return alert('Setup name required');
    const s = collectFormSetup();
    s.name = name;
    const r = await fetch('/api/setups', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(s) });
    const j = await r.json();
    if (r.ok) { alert('Saved setup'); loadSetups(); } else alert('Error: '+(j.error||JSON.stringify(j)));
  });

  createDirectBtn.addEventListener('click', async ()=>{
    const body = collectFormSetup();
    const r = await fetch('/api/giveaways', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const json = await r.json();
    if (r.ok) { alert('Created'); loadGiveaways(); } else alert('Error: ' + (json.error||JSON.stringify(json)));
  });

  async function loadSetups() {
    setupsList.innerHTML = 'Loading...';
    const setups = await api('/api/setups');
    setupsList.innerHTML = '';
    const tpl = document.getElementById('setupItemTpl');
    setups.forEach(s => {
      const node = tpl.content.cloneNode(true);
      node.querySelector('.sname').textContent = s.name;
      node.querySelector('.smeta').textContent = `Guild: ${s.guildId} • Channel: ${s.channelId || 'none'}`;
      node.querySelector('.sdesc').textContent = `Base: ${s.basedAmount} • Dur: ${s.durationMinutes} min • Winners: ${s.winnersCount} • Extras: ${s.extras.map(x=>x.extra+'@'+x.roleId).join(',')}`;
      const useBtn = node.querySelector('.useBtn');
      const delBtn = node.querySelector('.delBtn');
      useBtn.addEventListener('click', async ()=> {
        if (!confirm(`Create giveaway from setup "${s.name}" now?`)) return;
        const body = {
          title: s.title || s.name,
          channelId: s.channelId,
          basedAmount: s.basedAmount,
          durationMinutes: s.durationMinutes,
          extras: s.extras,
          winners: s.winnersCount,
          clientSeed: null
        };
        const r = await fetch('/api/giveaways', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
        const j = await r.json();
        if (r.ok) { alert('Created'); loadGiveaways(); } else alert('Error: '+(j.error||JSON.stringify(j)));
      });
      delBtn.addEventListener('click', async ()=> {
        if (!confirm('Delete setup?')) return;
        const r = await fetch(`/api/setups/${s.id}`, { method:'DELETE' });
        const j = await r.json();
        if (r.ok) { loadSetups(); } else alert('Error: '+(j.error||JSON.stringify(j)));
      });
      setupsList.appendChild(node);
    });
  }

  async function loadGiveaways(){
    giveawaysDiv.innerHTML = '<div style="color:var(--muted)">Loading...</div>';
    const gws = await api('/api/giveaways');
    giveawaysDiv.innerHTML = '';
    const tpl = document.getElementById('gwTemplate');
    gws.forEach(gw => {
      const node = tpl.content.cloneNode(true);
      node.querySelector('.title').textContent = gw.title;
      node.querySelector('.meta').textContent = `ID: ${gw.id}`;
      node.querySelector('.desc').textContent = `Channel: ${gw.channelId} — Ends at: ${new Date(gw.endsAt).toLocaleString()}`;
      node.querySelector('.entriesCount').textContent = (gw.entries||[]).length;
      node.querySelector('.winnersCount').textContent = (gw.winners||[]).length;
      const refreshBtn = node.querySelector('.refreshBtn');
      const rollBtn = node.querySelector('.rollBtn');
      refreshBtn.addEventListener('click', async ()=>{
        const updated = await api(`/api/giveaways/${gw.id}`);
        node.querySelector('.entriesCount').textContent = (updated.entries||[]).length;
        node.querySelector('.winnersCount').textContent = (updated.winners||[]).length;
      });
      rollBtn.addEventListener('click', async ()=>{
        if (!confirm('Roll now? This will perform the provably-fair roll (if already rolled will fail).')) return;
        const resp = await fetch(`/api/giveaways/${gw.id}/roll`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({})});
        const json = await resp.json();
        if (resp.ok) {
          alert('Rolled: winners: ' + (json.winners || []).map(w => w.userId).join(', '));
          loadGiveaways();
        } else alert('Error: ' + (json.error||JSON.stringify(json)));
      });

      // Verify button
      const vbtn = document.createElement('button'); vbtn.textContent = 'Verify'; vbtn.style.marginLeft = '8px';
      vbtn.addEventListener('click', async ()=>{
        const resp = await fetch(`/api/giveaways/${gw.id}/verify`);
        const j = await resp.json();
        if (!resp.ok) return alert('Verify failed: ' + (j.error||JSON.stringify(j)));
        // display report in a new window or modal; simple: open JSON in new tab
        const w = window.open('about:blank','_blank');
        w.document.write('<pre>' + JSON.stringify(j, null, 2) + '</pre>');
      });
      const cont = node.querySelector('div > div:nth-child(3)');
      cont.appendChild(vbtn);

      giveawaysDiv.appendChild(node);
    });
  }

  // init
  await loadGuilds();
  await addExtraRow(); // start with one
  await loadSetups();
  await loadGiveaways();
  setInterval(loadGiveaways, 15000);
})();
