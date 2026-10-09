'use strict';
const S = {data:null, tab:'overview', gw:null, loading:false};
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const num = (v,d=1) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—';
const toN = v => {const x=Number(v);return Number.isFinite(x)?x:0;};
const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
const money = v => '£'+num(v,1)+'m';
const byId = () => Object.fromEntries(S.data.players.map(x=>[x.id,x]));
const clubs = () => Object.fromEntries(S.data.clubs.map(x=>[x.id,x]));
const player = id => byId()[id] || {id,web_name:'Unknown',team:0,element_type:0,now_cost:0};
const playerName = p => p.web_name || [p.first_name,p.second_name].filter(Boolean).join(' ');
const clubName = p => (clubs()[p.team]||{}).short_name||'???';
const position = p => ({1:'GK',2:'DEF',3:'MID',4:'FWD'})[p.element_type]||'?';
const myPlayers = () => S.data.picks.map(p=>({...p,p:player(p.element)}));
const GW = () => S.gw || S.data.gameweeks[0].id;
const fixtureList = (p, gw) => S.data.fixtures.filter(f=>f.event===gw && (f.team_h===p.team||f.team_a===p.team));
function fixtureText(p, gw){const fs=fixtureList(p,gw); if(!fs.length)return 'BLANK';return fs.map(f=>{const h=f.team_h===p.team;const rival=(clubs()[h?f.team_a:f.team_h]||{}).short_name||'?';return rival+(h?' (H)':' (A)');}).join(' + ');}
function fdr(p,gw){const fs=fixtureList(p,gw);if(!fs.length)return 0;return fs.reduce((a,f)=>a+(f.team_h===p.team?toN(f.team_h_difficulty):toN(f.team_a_difficulty)),0)/fs.length;}
function availability(p){if(['u','s','i'].includes(p.status)) return 0.02;if(p.chance_of_playing_next_round!=null) return clamp(toN(p.chance_of_playing_next_round)/100,.03,1);if(p.status==='d')return .65;return 1;}
function expected(p, gw){
  const fs=fixtureList(p,gw);if(!fs.length)return 0;
  const form=toN(p.form),ppg=toN(p.points_per_game),ep=toN(p.ep_next);
  const sample=ep>0?ep:(ppg||form);
  const base=clamp(.42*form+.36*ppg+.22*sample,.3,12);
  // Early-season minutes-based estimate of starting likelihood, deliberately conservative.
  const sampleGWs=Math.max(1,Math.min(38,toN(S.data.published_gw)));
  const minutesFactor=clamp(toN(p.minutes)/(sampleGWs*80),.40,1);
  const multipliers={1:1.30,2:1.16,3:1,4:.85,5:.72};
  const chance=availability(p)*minutesFactor;
  const total=fs.reduce((sum,f)=>sum+base*(multipliers[f.team_h===p.team?f.team_h_difficulty:f.team_a_difficulty]||1),0);
  return Math.max(0,total*chance);
}
const xp = (p,gw) => expected(p,gw);
function bestXI(roster, gw){
  // Exhaustive legal formations: exactly 1 GK, 3–5 DEF, 2–5 MID, 1–3 FWD.
  const groups={1:[],2:[],3:[],4:[]};
  roster.forEach(r=>{if(groups[r.p.element_type]) groups[r.p.element_type].push(r);});
  for(const arr of Object.values(groups))arr.sort((a,b)=>xp(b.p,gw)-xp(a.p,gw));
  let best=null;
  for(let d=3;d<=5;d++)for(let m=2;m<=5;m++){
    const f=10-d-m;
    if(f<1||f>3)continue;
    if(groups[1].length<1||groups[2].length<d||groups[3].length<m||groups[4].length<f)continue;
    const starters=[groups[1][0],...groups[2].slice(0,d),...groups[3].slice(0,m),...groups[4].slice(0,f)];
    const raw=starters.reduce((sum,r)=>sum+xp(r.p,gw),0);
    if(!best||raw>best.raw) best={starters,raw,formation:`${d}-${m}-${f}`};
  }
  if(!best)return {starters:[],bench:roster,raw:0,total:0,captain:null,vice:null,formation:'—'};
  const ids=new Set(best.starters.map(r=>r.element));
  const bench=roster.filter(r=>!ids.has(r.element)).sort((a,b)=>xp(b.p,gw)-xp(a.p,gw));
  const captain=[...best.starters].sort((a,b)=>xp(b.p,gw)-xp(a.p,gw))[0];
  const vice=[...best.starters].sort((a,b)=>xp(b.p,gw)-xp(a.p,gw))[1];
  return {...best,bench,captain,vice,total:best.raw+xp(captain.p,gw)};
}
function plan(){return S.data.gameweeks.slice(0,5).map(g=>({gw:g.id,deadline:g.deadline_time,...bestXI(myPlayers(),g.id)}));}
function teamRating(xpts){return clamp(Math.round(28+xpts*.95),1,99);}
function suggestions(){
  const all=S.data.players, roster=myPlayers(), owned=new Set(roster.map(r=>r.element)), bank=toN(S.data.bank), weights=[1,.88,.78,.66,.55];
  const clubcounts={};roster.forEach(r=>clubcounts[r.p.team]=(clubcounts[r.p.team]||0)+1);
  const five=S.data.gameweeks.slice(0,5);
  const total=p=>five.reduce((acc,g,i)=>acc+weights[i]*xp(p,g.id),0);
  const possibles=[];
  for(const old of roster){
    for(const p of all){
      if(owned.has(p.id)||p.element_type!==old.p.element_type || (p.team!==old.p.team && (clubcounts[p.team]||0)>=3))continue;
      if(toN(p.now_cost)>toN(old.p.now_cost)+bank*10+0.01)continue;
      if(availability(p)<.70 || toN(p.minutes) < Math.min(100,S.data.published_gw*20))continue;
      const gain=total(p)-total(old.p);
      if(gain>2) possibles.push({old,p,gain,delta:(toN(p.now_cost)-toN(old.p.now_cost))/10});
    }
  }
  possibles.sort((a,b)=>b.gain-a.gain);
  const usedIn=new Set(),usedOut=new Set();
  return possibles.filter(v=>{
    if(usedIn.has(v.p.id)||usedOut.has(v.old.element))return false;
    usedIn.add(v.p.id);usedOut.add(v.old.element);return true;
  }).slice(0,6);
}
const iname=(r)=>esc(playerName(r.p));
function stats(){
  const p=plan(),a=p[0];const rating=teamRating(a.total);
  return `<div class="stats">
    <article class="stat highlight"><div class="stat-label">Squad rating <span>✦</span></div><div class="stat-number">${rating}<em> / 100</em></div><div class="stat-foot">Indicative heuristic · next GW</div></article>
    <article class="stat"><div class="stat-label">GW ${a.gw} projection <span>↗</span></div><div class="stat-number">${num(a.total)}<em> pts</em></div><div class="stat-foot">Optimised XI + captain</div></article>
    <article class="stat"><div class="stat-label">Next 5 gameweeks <span>◫</span></div><div class="stat-number">${num(p.reduce((s,x)=>s+x.total,0),0)}<em> pts</em></div><div class="stat-foot">Modelled starting XI each week</div></article>
    <article class="stat"><div class="stat-label">Money in bank <span>£</span></div><div class="stat-number">${money(S.data.bank)}</div><div class="stat-foot">Last published GW · may be outdated</div></article>
  </div>`;
}
function bars(){
  const p=plan();const max=Math.max(1,...p.map(x=>x.total));const best=Math.max(...p.map(x=>x.total));
  return `<div class="bars">${p.map(g=>`<div class="bar-wrap"><div class="bar-label">${num(g.total,0)} pts</div><div class="bar-space"><div class="bar ${g.total===best?'best':''}" style="height:${Math.max(3,g.total/max*135)}px"></div></div><div class="bar-gw">GW ${g.gw}</div><div class="bar-current">${g.formation}</div></div>`).join('')}</div>`;
}
function pitch(gw){
  const l=bestXI(myPlayers(),gw), positions=[1,2,3,4];
  const rows=positions.map(t=>`<div class="pitch-row">${l.starters.filter(r=>r.p.element_type===t).map(r=>{
    const c=l.captain&&l.captain.element===r.element;
    return `<div class="pitch-person"><div class="shirt ${t===1?'goalkeeper':''} ${c?'captain':''}">${c?'C':''}</div><div class="person-name" title="${esc(playerName(r.p))}">${iname(r)}</div><span class="person-points">${num(xp(r.p,gw))} xP</span></div>`;
  }).join('')}</div>`).join('');
  return `<div class="pitch">${rows}</div><p class="pitch-caption">Projected optimal ${esc(l.formation)} · captain ${l.captain?iname(l.captain):'—'} · automatically selected per gameweek</p><div class="bench">${l.bench.map(r=>`<div class="bench-player"><strong>${iname(r)}</strong><small>${position(r.p)} · ${num(xp(r.p,gw))} xP</small></div>`).join('')}</div>`;
}
function highlights(){
  const l=bestXI(myPlayers(),GW()),s=suggestions(),capt=l.captain;const low=l.bench[0];
  return `<div class="reco"><div class="reco-icon">♛</div><div><h3>Captain: ${capt?iname(capt):'—'}</h3><p>Highest modelled starter for GW ${GW()}, at ${capt?num(xp(capt.p,GW())):'—'} expected points before doubling.</p></div></div>
  <div class="reco"><div class="reco-icon">⇄</div><div><h3>${s.length?'Transfer watch: '+esc(playerName(s[0].p)):'No clear transfer upgrade'}</h3><p>${s.length?`${esc(playerName(s[0].old.p))} → ${esc(playerName(s[0].p))}, potential +${num(s[0].gain)} modelled weighted points across five weeks.`:'Your current squad has no affordable, clear upgrade under the simple model.'}</p></div></div>
  <div class="reco"><div class="reco-icon">▤</div><div><h3>Bench outlook</h3><p>${low?`${esc(playerName(low.p))} leads the bench for GW ${GW()} (${num(xp(low.p,GW()))} xP).`:'No bench selection available.'} Compare potential Bench Boost weeks on the Chips tab.</p></div></div>`;
}
function overview(){
  return stats()+`<div class="grid"><section class="panel"><div class="panel-head"><div><h2>5-gameweek projection</h2><p>Expected points including captain, with optimal legal lineups.</p></div><span class="mini-tag">NEXT 5 GWs</span></div>${bars()}</section>
    <section class="panel"><div class="panel-head"><div><h2>AI-style manager insights</h2><p>Decision support based on published FPL statistics.</p></div><span class="mini-tag">GW ${GW()}</span></div>${highlights()}</section></div>
    <div class="grid"><section class="panel"><div class="panel-head"><div><h2>Recommended starting XI</h2><p>Formation and captain optimised for GW ${GW()}.</p></div><span class="mini-tag">${bestXI(myPlayers(),GW()).formation}</span></div>${pitch(GW())}</section>
    <section class="panel"><div class="panel-head"><div><h2>Team snapshot</h2><p>Latest publicly visible FPL information.</p></div></div>
      <div class="summary-list"><div class="summary-item"><span>Team</span><b>${esc(S.data.entry.name||'—')}</b></div><div class="summary-item"><span>Manager</span><b>${esc([S.data.entry.player_first_name,S.data.entry.player_last_name].filter(Boolean).join(' '))}</b></div><div class="summary-item"><span>Last published squad</span><b>GW ${S.data.published_gw}</b></div><div class="summary-item"><span>Total FPL points</span><b>${esc(S.data.entry.summary_overall_points??'—')}</b></div><div class="summary-item"><span>Overall rank</span><b>${S.data.entry.summary_overall_rank?Math.round(S.data.entry.summary_overall_rank).toLocaleString():'—'}</b></div><div class="summary-item"><span>Last published squad value</span><b>${money(S.data.team_value)}</b></div><div class="summary-item"><span>Chip history</span><b>${S.data.used_chips.length} recorded</b></div></div>
      <div class="split-line"></div><h3 class="section-title">Recent FPL points</h3>${historyChart()}<div class="fineprint">Squad, bank and chip data reflect publicly released information. They may not include transfers you have just made before the next deadline.</div>
    </section></div>`;
}
function historyChart(){const a=S.data.history;if(!a.length)return '<p class="muted">No published history yet.</p>';const max=Math.max(1,...a.map(x=>toN(x.points)));return `<div class="history-row">${a.map(x=>`<div class="hist-col"><div class="hist-stick" title="${toN(x.points)} pts" style="height:${Math.max(4,80*toN(x.points)/max)}px"></div><small>${esc(x.event)}</small></div>`).join('')}</div><div class="fineprint" style="text-align:center;margin-top:3px">Recent gameweeks · bar heights represent points earned</div>`;}
function gwSwitch(){return `<div class="gw-switch">${S.data.gameweeks.slice(0,5).map(g=>`<button data-gw="${g.id}" class="${GW()===g.id?'active':''}">GW ${g.id}</button>`).join('')}</div>`;}
function squadTable(){return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Player</th><th>Price</th><th>GW ${GW()} fixture</th><th>FDR</th><th>xP</th><th>Availability</th></tr></thead><tbody>${myPlayers().sort((a,b)=>a.p.element_type-b.p.element_type||xp(b.p,GW())-xp(a.p,GW())).map(r=>{const p=r.p, diff=fdr(p,GW());return `<tr><td><span class="player-name">${iname(r)}</span><span class="player-sub">${esc(clubName(p))} · ${position(p)}${r.is_captain?' · FPL captain':''}</span></td><td>${money(toN(p.now_cost)/10)}</td><td>${esc(fixtureText(p,GW()))}</td><td><span class="pill ${!diff?'bad':diff>=4?'mid':''}">${diff?num(diff):'—'}</span></td><td class="accent"><b>${num(xp(p,GW()))}</b></td><td><span class="pill ${availability(p)<.7?'bad':availability(p)<1?'mid':''}">${availability(p)>=.99?'Available':Math.round(availability(p)*100)+'%'}</span></td></tr>`;}).join('')}</tbody></table></div>`;}
function squad(){const l=bestXI(myPlayers(),GW());return stats()+gwSwitch()+`<div class="grid"><section class="panel"><div class="panel-head"><div><h2>Best XI for GW ${GW()}</h2><p>Model-selected ${l.formation} — does not change your real FPL lineup.</p></div><span class="mini-tag">${num(l.total)} xP</span></div>${pitch(GW())}</section><section class="panel"><div class="panel-head"><div><h2>Your 15 players</h2><p>Upcoming matchups, estimated points and availability.</p></div></div>${squadTable()}</section></div>`;}
function planner(){const p=plan(),l=bestXI(myPlayers(),GW());return gwSwitch()+stats()+`<div class="grid"><section class="panel"><div class="panel-head"><div><h2>Gameweek ${GW()} plan</h2><p>Review the automatically selected lineup and captain.</p></div><span class="mini-tag">${esc(l.formation)}</span></div>${pitch(GW())}</section><section class="panel"><div class="panel-head"><div><h2>Your GW ${GW()} checklist</h2><p>Fixtures and choices based on published squad data.</p></div></div><div class="summary-list"><div class="summary-item"><span>Expected total incl. captain</span><b class="accent">${num(l.total)} xP</b></div><div class="summary-item"><span>Best captain</span><b>${l.captain?iname(l.captain):'—'}</b></div><div class="summary-item"><span>Vice-captain</span><b>${l.vice?iname(l.vice):'—'}</b></div><div class="summary-item"><span>Best formation</span><b>${l.formation}</b></div><div class="summary-item"><span>Blank fixtures in squad</span><b>${myPlayers().filter(r=>!fixtureList(r.p,GW()).length).length}</b></div><div class="summary-item"><span>Double fixtures in squad</span><b>${myPlayers().filter(r=>fixtureList(r.p,GW()).length>1).length}</b></div></div><p class="fineprint">Model assumes fit players with normal minutes and uses fixture difficulty, form and season statistics. It does not know team news not recorded by FPL.</p></section></div><section class="panel"><div class="panel-head"><div><h2>5-week fixture planning</h2><p>Compare modelled team strength and the best captain across upcoming deadlines.</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Gameweek</th><th>Projected XI</th><th>Captain</th><th>Captain xP</th><th>Formation</th><th>Deadline (UK)</th></tr></thead><tbody>${p.map(x=>`<tr><td><b>GW ${x.gw}</b></td><td class="accent"><b>${num(x.total)} pts</b></td><td>${x.captain?iname(x.captain):'—'}</td><td>${x.captain?num(xp(x.captain.p,x.gw)):'—'}</td><td>${x.formation}</td><td>${new Date(x.deadline).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'})}</td></tr>`).join('')}</tbody></table></div></section>`;}
function transfers(){const ss=suggestions();return `<div class="grid"><section class="panel"><div class="panel-head"><div><h2>Transfer optimiser</h2><p>Projected five-week gains weighted towards nearer gameweeks.</p></div><span class="mini-tag">PRICE-AWARE</span></div>${ss.length?ss.map((x,i)=>`<div class="transfer-card"><div class="transfer-player"><strong class="danger">${esc(playerName(x.old.p))}</strong><small>OUT · ${esc(clubName(x.old.p))} · ${position(x.old.p)} · ${money(toN(x.old.p.now_cost)/10)}</small></div><div class="transfer-arrow">→</div><div class="transfer-player"><strong class="accent">${esc(playerName(x.p))}</strong><small>IN · ${esc(clubName(x.p))} · ${position(x.p)} · ${money(toN(x.p.now_cost)/10)}</small></div><div class="gain">+${num(x.gain)}<small>weighted xP · 5 GW</small></div></div>`).join(''):'<p class="muted">No viable upgrades found at these indicative prices, or the current published squad already rates well.</p>'}<p class="note">* These are model estimates, not verified AI forecasts. Prices use current listed player values rather than your actual selling prices. Budget may be different if you have made unpublished transfers. Check bank, exact selling price and free transfers inside FPL before acting. Transfer hits are not deducted.</p></section><section class="panel"><div class="panel-head"><div><h2>Transfer decision guide</h2><p>How to turn suggestions into an actionable move.</p></div></div><div class="reco"><div class="reco-icon">1</div><div><h3>Check your free transfers</h3><p>Public FPL data does not reliably reveal how many free transfers you currently have.</p></div></div><div class="reco"><div class="reco-icon">2</div><div><h3>Compare value over multiple weeks</h3><p>Prioritise players with sustained favourable matchups rather than one attractive fixture.</p></div></div><div class="reco"><div class="reco-icon">3</div><div><h3>Include the hit cost</h3><p>A paid transfer normally costs four FPL points. Only consider it if expected benefits outweigh the cost and risk.</p></div></div><div class="reco"><div class="reco-icon">4</div><div><h3>Make changes inside FPL</h3><p>This planner is read-only and will never submit a transfer on your behalf.</p></div></div></section></div>`;}
function chips(){
 const gwPlans=plan();
 const summaries=gwPlans.map(v=>{const bench=v.bench.reduce((s,r)=>s+xp(r.p,v.gw),0), capt=v.captain?xp(v.captain.p,v.gw):0,blank=myPlayers().filter(r=>!fixtureList(r.p,v.gw).length).length,doubles=myPlayers().filter(r=>fixtureList(r.p,v.gw).length>1).length;
   return {...v,bench,capt,blank,doubles};});
 const best=(key)=>[...summaries].sort((a,b)=>b[key]-a[key])[0];
 const bb=best('bench'),tc=best('capt'),fh=best('blank'),wc=[...summaries].sort((a,b)=>a.total-b.total)[0];
 const lastUsed=n=>S.data.used_chips.filter(x=>String(x.name||'').toLowerCase().includes(n)).map(x=>'GW '+x.event).join(', ');
 function chip(symbol,title,who,why,key){return `<article class="chip-card"><div class="chip-title"><h3>${esc(title)}</h3><span class="chip-symbol">${symbol}</span></div><div class="chip-label">${esc(who)}</div><div class="chip-best">${key?'GW '+key:'Review'}</div><p>${esc(why)}</p><p class="note">Recorded uses: ${esc(lastUsed(title.toLowerCase().replace(' boost','').replace(' captain','').replace(' hit','')) || 'None in public history')}</p></article>`;}
 return `<section class="panel"><div class="panel-head"><div><h2>Chip strategy lab</h2><p>Illustrative opportunities from your next five gameweeks — not an instruction to activate a chip.</p></div><span class="mini-tag">5-GW OUTLOOK</span></div><div class="chip-grid">
 ${chip('👑','Triple Captain','HIGHEST CAPTAIN CEILING',`Your strongest predicted captain in the next five weeks is ${tc.captain?playerName(tc.captain.p):'unknown'} at ${num(tc.capt)} xP. Check for confirmed doubles and reliable minutes before committing.`,tc.gw)}
 ${chip('▤','Bench Boost','HIGHEST BENCH PROJECTION',`Your four bench players project for about ${num(bb.bench)} combined points in this gameweek. Review all 15 starters for injury and fixture risk.`,bb.gw)}
 ${chip('↗','Free Hit','MOST SQUAD BLANKS',`${fh.blank} of your currently owned players have no fixture in this gameweek. A Free Hit can be useful only if a temporary replacement squad clearly beats your normal XI.`,fh.blank?fh.gw:null)}
 ${chip('✦','Wildcard','SQUAD REBUILD REVIEW',`Your lowest modelled week is GW ${wc.gw} (${num(wc.total)} xP). This alone is NOT sufficient to justify a Wildcard; review injuries, weak long-term fixtures, budget and the remaining chip deadlines.`,null)}
 </div><div class="fineprint">Chip availability is not authenticated. Check exactly which chips remain in your FPL account and the current season's usage/deadline rules. Public chip history may be incomplete or delayed.</div></section>`;
}
function render(){if(!S.data)return;const body={overview,squad,planner,transfers,chips}[S.tab]();$('content').innerHTML=body;document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===S.tab));document.querySelectorAll('[data-gw]').forEach(b=>b.addEventListener('click',()=>{S.gw=Number(b.dataset.gw);render();}));}
async function load(demo=false){
 if(S.loading)return;
 S.loading=true;$('error').classList.add('hidden');$('loading').classList.remove('hidden');$('content').classList.add('hidden');$('sample-banner').classList.add('hidden');
 $('connection-label').textContent='Connecting';$('connection-label').classList.remove('connected');
 const entry=$('entry-id').value.trim();
 $('fpl-link').href=`https://fantasy.premierleague.com/en/entry/${encodeURIComponent(entry)}/history`;
 try{
   const r=await fetch(`/api/data?${demo?'demo=1':'entry='+encodeURIComponent(entry)}`);const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not load FPL data');
   S.data=data;S.gw=data.gameweeks[0].id;S.tab='overview';
   $('greeting').innerHTML=(data.mode==='demo'?'Demo team':esc(data.entry.name||'Your FPL team'))+'<span class="period">.</span>';
   $('intro').textContent=data.mode==='demo'?'Explore all features using clearly fictional data.':'Live published FPL squad • GW '+data.published_gw+' last visible • '+data.gameweeks.length+' upcoming gameweeks';
   $('connection-label').innerHTML='<i></i>'+(data.mode==='demo'?'Demo mode':'Public data loaded');$('connection-label').classList.add('connected');
   $('sample-banner').classList.toggle('hidden',data.mode!=='demo');
   $('content').classList.remove('hidden');render();
 }catch(err){$('error').classList.remove('hidden');$('error').innerHTML=`<b>Connection not available.</b> ${esc(err.message)}<div style="margin-top:8px">You can still explore the working dashboard with <button id="try-demo">fictional demo data →</button></div>`;$('try-demo').onclick=()=>load(true);$('connection-label').textContent='Offline';
 }finally{S.loading=false;$('loading').classList.add('hidden');}
}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{if(!S.data)return;S.tab=t.dataset.tab;render();window.scrollTo({top:0,behavior:'smooth'});});
$('connect').onclick=()=>load(false);
$('refresh').onclick=()=>load(S.data?.mode==='demo');
$('live-retry').onclick=()=>load(false);
$('entry-id').addEventListener('keydown',e=>{if(e.key==='Enter')load(false);});
const params=new URLSearchParams(location.search);if(params.get('demo')==='1')load(true);else load(false);
