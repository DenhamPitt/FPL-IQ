'use strict';
const S = {data:null, tab:'overview', gw:null, loading:false, savedTransfers:[], draft:{out:'',incoming:'',query:'',status:'made',hit:0}, review:null, notice:'', forecasts:[], resultsBusy:false, resultsStatus:''};
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
const publicPlayers = () => S.data.picks.map(p=>({...p,p:player(p.element)}));
// The local transfer plan is deliberately separate from published FPL picks.
// It changes ONLY projections in this browser. It never submits a transfer to FPL.
function applyTransfers(roster, transfers) {
  const result=roster.map(r=>({...r}));
  for(const change of transfers) {
    const i=result.findIndex(r=>r.element===change.out);
    if(i<0 || result.some(r=>r.element===change.incoming)) continue;
    result[i]={...result[i],element:change.incoming,p:player(change.incoming),is_captain:false,is_vice_captain:false,planned:true};
  }
  return result;
}
const myPlayers = () => applyTransfers(publicPlayers(),S.savedTransfers);
function savedKey(){return `fpl-iq-transfers-v1-${S.data.mode}-${S.data.team_id}`;}
function readSaved(){
  try {const v=JSON.parse(localStorage.getItem(savedKey())||'[]');return Array.isArray(v)?v.filter(t=>Number.isSafeInteger(t.out)&&Number.isSafeInteger(t.incoming)&&['planned','made'].includes(t.status)).slice(0,15):[];}
  catch {return [];}
}
function persistSaved(){
  try {localStorage.setItem(savedKey(),JSON.stringify(S.savedTransfers));return true;}
  catch {S.notice='Browser storage is unavailable, so this plan may not survive a refresh.';return false;}
}
function syncSaved(){
  const original=new Set(S.data.picks.map(p=>p.element));
  const kept=[];let removed=0;
  for(const t of S.savedTransfers){
    if(!original.has(t.out) && original.has(t.incoming)){removed++;continue;} // Now published by FPL.
    const roster=applyTransfers(publicPlayers(),kept);
    if(!roster.some(r=>r.element===t.out) || roster.some(r=>r.element===t.incoming)){removed++;continue;}
    kept.push(t);
  }
  S.savedTransfers=kept;
  if(removed){persistSaved();S.notice=`${removed} saved transfer(s) reconciled or cleared after the FPL squad update.`;}
}
function availableBank(){ // Indicative only: actual purchase selling prices are private.
  return toN(S.data.bank)+S.savedTransfers.reduce((sum,t)=>sum+(toN(player(t.out).now_cost)-toN(player(t.incoming).now_cost))/10,0);
}
function fiveWeighted(roster){
  const w=[1,.88,.78,.66,.55];
  return S.data.gameweeks.slice(0,5).reduce((sum,g,i)=>sum+w[i]*bestXI(roster,g.id).total,0);
}
function playerWeighted(p){
  const w=[1,.88,.78,.66,.55];
  return S.data.gameweeks.slice(0,5).reduce((sum,g,i)=>sum+w[i]*xp(p,g.id),0);
}
function evaluateTransfer(outId,inId,status='planned',hit=0){
  const before=myPlayers(); const old=before.find(r=>r.element===outId);const incoming=player(inId);
  const errors=[],warnings=[];
  if(!old)errors.push('Choose a player currently in your planning squad.');
  if(!S.data.players.some(p=>p.id===inId))errors.push('Choose a valid incoming FPL player.');
  if(old && incoming.element_type!==old.p.element_type)errors.push('FPL transfers must replace a player in the same position.');
  if(before.some(r=>r.element===inId))errors.push('That player is already in your squad.');
  if(old && incoming.team!==old.p.team && before.filter(r=>r.p.team===incoming.team).length>=3)errors.push('You cannot have more than three players from the same club.');
  if(errors.length)return {ok:false,errors,warnings};
  const after=applyTransfers(before,[{out:outId,incoming:inId}]);
  const beforeNext=bestXI(before,GW()).total,afterNext=bestXI(after,GW()).total;
  const beforeFive=fiveWeighted(before),afterFive=fiveWeighted(after);
  const gain=afterFive-beforeFive,hitCost=status==='planned'?hit:0,net=gain-hitCost;
  const bankAfter=availableBank()+(toN(old.p.now_cost)-toN(incoming.now_cost))/10;
  if(bankAfter<-.001)warnings.push('Estimated budget is short. Public prices are not your actual selling prices; check your FPL transfer screen before committing.');
  else warnings.push('Budget is approximate: FPL may give you a different selling price for the outgoing player.');
  if(availability(incoming)<.7)warnings.push('Incoming player has an availability flag or reduced expected playing chance.');
  if(!fixtureList(incoming,GW()).length)warnings.push('Incoming player has no fixture in the next gameweek.');
  if(status==='made')warnings.push('This is marked as already made in FPL. We will show it immediately in FPL IQ but cannot verify or submit it to FPL.');
  else if(hit)warnings.push('You selected a -4 hit; 4 points are deducted from the five-week assessment.');
  let verdict='Avoid for now',tone='bad';
  if(net>=4){verdict='Strong modelled upgrade';tone='good';}
  else if(net>=1.5){verdict='Looks promising';tone='good';}
  else if(net>=-1.5){verdict='Close call — weigh the context';tone='mid';}
  return {ok:true,errors,warnings,old:old.p,incoming,afterNext,beforeNext,beforeFive,afterFive,gain,net,bankAfter,verdict,tone,hit:hitCost};
}


// FORECAST AUDIT TRAIL. A locked prediction is calculated from a pre-deadline
// FPL data snapshot, and never reconstructed retrospectively from later stats.
const MODEL_VERSION='heuristic-1.0';
function forecastKey(){return `fpl-iq-forecasts-v1-${S.data.mode}-${S.data.team_id}`;}
function readForecasts(){
 try {const data=JSON.parse(localStorage.getItem(forecastKey())||'[]');
  return Array.isArray(data)?data.filter(v=>v&&v.schema===1&&Number.isInteger(v.gw)&&Array.isArray(v.players)&&v.team===S.data.team_id).slice(0,38):[];
 }catch{return [];}
}
function persistForecasts(){
 try {localStorage.setItem(forecastKey(),JSON.stringify(S.forecasts));return true;}
 catch {S.resultsStatus='Browser storage is disabled; predictions may be lost on refresh.';return false;}
}
function deadlineFor(gw){return S.data.gameweeks.find(x=>x.id===gw)?.deadline_time||null;}
function preDeadline(gw){
 const deadline=deadlineFor(gw);
 return Boolean(deadline && Date.now()<new Date(deadline).getTime() && new Date(S.data.fetched_at).getTime()<new Date(deadline).getTime());
}
function captureForecast(gw,force=false){
 const deadline=deadlineFor(gw), previous=S.forecasts.find(x=>x.gw===gw);
 if(!preDeadline(gw)||(!force&&previous))return false;
 const roster=myPlayers(),chosen=bestXI(roster,gw);
 if(roster.length!==15||chosen.starters.length!==11)return false;
 const starters=new Set(chosen.starters.map(x=>x.element));
 const snap={schema:1,team:S.data.team_id,mode:S.data.mode,gw,deadline,
  capturedAt:new Date().toISOString(), dataAsOf:S.data.fetched_at,
  model:MODEL_VERSION,revision:(previous?.revision||0)+1,
  players:roster.map(r=>({id:r.element,name:playerName(r.p),club:clubName(r.p),position:position(r.p),
    xp:Math.round(xp(r.p,gw)*1000)/1000,starter:starters.has(r.element),captain:r.element===chosen.captain?.element})),
  projectedXI:Math.round(chosen.total*1000)/1000,formation:chosen.formation,
  transfers:S.savedTransfers.map(t=>({out:t.out,incoming:t.incoming,status:t.status}))};
 if(previous?.actual)snap.actual=previous.actual;
 S.forecasts=S.forecasts.filter(x=>x.gw!==gw).concat(snap).sort((a,b)=>a.gw-b.gw);
 persistForecasts();return true;
}
function initialiseForecasts(){
 S.forecasts=readForecasts();
 if(S.data.mode==='demo'){S.resultsStatus='Demo forecasts are fictional and not compared with official FPL points.';return;}
 const next=S.data.gameweeks[0];
 if(next&&captureForecast(next.id))S.resultsStatus=`GW ${next.id} forecast saved automatically before the deadline.`;
}
function forecastScore(snap){
 if(!snap.actual?.final)return null;
 const pts=snap.actual.points;
 if(!snap.players.every(p=>Number.isFinite(pts[String(p.id)])))return null;
 const errors=snap.players.map(p=>({ ...p,actual:pts[String(p.id)],error:pts[String(p.id)]-p.xp}));
 const starterTotal=errors.reduce((s,p)=>s+(p.starter?p.actual:0)+(p.captain?p.actual:0),0);
 const teamX=errors.reduce((s,p)=>s+(p.starter?p.xp:0)+(p.captain?p.xp:0),0);
 return {gw:snap.gw,rows:errors, predicted:teamX,actual:starterTotal,
  difference:starterTotal-teamX,mae:errors.reduce((s,p)=>s+Math.abs(p.error),0)/errors.length,
  bias:errors.reduce((s,p)=>s+p.error,0)/errors.length,managerPoints:snap.actual.manager_points};
}
function forecastScores(){return S.forecasts.map(forecastScore).filter(Boolean).sort((a,b)=>a.gw-b.gw);}
async function fetchFinalResults(){
 if(S.resultsBusy||!S.data||S.data.mode==='demo'||!S.forecasts.length)return;
 S.resultsBusy=true;
 const pending=S.forecasts.filter(f=>!f.actual?.final || !forecastScore(f));
 let ready=0;
 try {
  for(const snap of pending){
   // Do not check before deadline; limits unnecessary calls to the FPL website.
   if(Date.now()<new Date(snap.deadline).getTime())continue;
   try{
    const res=await fetch(`/api/gw-results?entry=${encodeURIComponent(S.data.team_id)}&gw=${snap.gw}`);
    const payload=await res.json();
    if(!res.ok)throw new Error(payload.error||'FPL results unavailable');
    if(payload.final){
      snap.actual={final:true,points:payload.points,manager_points:payload.manager_points,verified_at:payload.verified_at};
      ready++;
    }
   }catch(e){S.resultsStatus=`Some completed results could not be checked: ${e.message}`;}
  }
  if(ready){persistForecasts();S.resultsStatus=`${ready} completed gameweek result${ready===1?'':'s'} verified against FPL.`;}
 }finally{
  S.resultsBusy=false;
  if(S.tab==='accuracy')render();
 }
}
function fitCalibration(scores){
 // Chronological holdout: at least 3 complete GWs for training and 2 for validation.
 if(scores.length<5)return null;
 const train=scores.slice(0,-2).flatMap(g=>g.rows);
 const test=scores.slice(-2).flatMap(g=>g.rows);
 const base=train.reduce((s,p)=>s+p.xp,0);
 if(base<=0)return null;
 const factor=clamp(train.reduce((s,p)=>s+p.actual,0)/base,.8,1.2);
 const baseMAE=test.reduce((s,p)=>s+Math.abs(p.actual-p.xp),0)/test.length;
 const adjMAE=test.reduce((s,p)=>s+Math.abs(p.actual-p.xp*factor),0)/test.length;
 return {factor,baseMAE,adjMAE,improved:(baseMAE-adjMAE)>Math.max(.05,baseMAE*.02),heldout:scores.slice(-2).map(x=>x.gw)};
}
function accuracy(){
 const saved=[...S.forecasts].sort((a,b)=>b.gw-a.gw), scored=forecastScores();
 const all=scored.flatMap(x=>x.rows);
 const mae=all.length?all.reduce((s,r)=>s+Math.abs(r.error),0)/all.length:null;
 const bias=all.length?all.reduce((s,r)=>s+r.error,0)/all.length:null;
 const next=S.data.gameweeks[0], upcoming=next&&preDeadline(next.id);
 const nextSaved=next&&S.forecasts.find(s=>s.gw===next.id);
 const calibration=fitCalibration(scored);
 const positionRows=['GK','DEF','MID','FWD'].map(pos=>{
   const a=all.filter(p=>p.position===pos);
   return a.length?`<tr><td>${pos}</td><td>${a.length}</td><td>${num(a.reduce((s,p)=>s+Math.abs(p.error),0)/a.length,2)}</td><td>${signed(a.reduce((s,p)=>s+p.error,0)/a.length)}</td></tr>`:'';
 }).join('');
 return `<section class="panel"><div class="panel-head"><div><h2>Prediction tracker</h2><p>We record genuine forecasts before the deadline and compare with FPL points only once the gameweek is final.</p></div><span class="mini-tag">${esc(MODEL_VERSION)}</span></div>
 <p class="fineprint">Each forecast contains your planned 15 players, model-selected XI and captain, player xP, model version and timestamp. Stored privately in this browser, not shared between devices. No old forecasts are invented.</p>
 ${S.resultsStatus?`<p class="plan-alert">${esc(S.resultsStatus)}</p>`:''}
 ${upcoming?`<div class="tracker-action"><div><strong>GW ${next.id} ${nextSaved?'forecast already saved':'ready to save'}</strong><small>${nextSaved?`Saved ${new Date(nextSaved.capturedAt).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'})} · revision ${nextSaved.revision}`:'Save the current squad, including your local transfer plans, before the deadline.'}</small></div><button id="save-forecast" class="primary-btn">${nextSaved?'Update GW '+next.id+' forecast':'Save GW '+next.id+' forecast'}</button></div>`:''}
 ${!upcoming?'<p class="fineprint">Pre-deadline snapshotting is available when a future gameweek is listed.</p>':''}
 <div class="tracker-stats"><div><small>Completed forecasts</small><b>${scored.length}</b></div><div><small>Player xP MAE</small><b>${mae==null?'—':num(mae,2)}</b></div><div><small>Actual − predicted bias</small><b>${bias==null?'—':signed(bias)}</b></div></div>
 <p class="fineprint">MAE = average absolute error in player points (lower is better). Positive bias means we underpredicted; negative bias means we overpredicted. Includes all 15 locked squad players, even substitutes.</p>
 </section>
 <section class="panel"><div class="panel-head"><div><h2>Predicted vs actual by GW</h2><p>Our selected XI and doubled captain compared with the final raw points those exact players earned.</p></div><button id="check-results" class="subtle-btn" ${S.resultsBusy?'disabled':''}>${S.resultsBusy?'Checking…':'Check results ↻'}</button></div>
 ${saved.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Gameweek</th><th>Predicted XI</th><th>Actual XI</th><th>Difference</th><th>Player MAE</th><th>Status</th></tr></thead><tbody>${saved.map(s=>{const r=forecastScore(s);return `<tr><td><b>GW ${s.gw}</b><div class="player-sub">${esc(s.model)} · v${s.revision}</div></td><td>${num(s.projectedXI)}</td><td>${r?num(r.actual,0):'—'}</td><td>${r?signed(r.difference):'—'}</td><td>${r?num(r.mae,2):'—'}</td><td>${r?'<span class="pill">Final</span>':'<span class="pill mid">Awaiting FPL final</span>'}</td></tr>`;}).join('')}</tbody></table></div>`:'<p class="muted">No saved pre-deadline predictions yet. Open the app before the next deadline to start collecting them.</p>'}
 <p class="fineprint">The “Actual XI” is how our predicted XI would have scored, without autosubs, vice-captain substitutions, chips or transfer hits. It is NOT necessarily your official FPL points total.</p></section>
 ${scored.length?`<div class="grid half"><section class="panel"><div class="panel-head"><div><h2>Where are we missing?</h2><p>Average error by playing position, across saved forecasts.</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Position</th><th>Samples</th><th>MAE</th><th>Bias</th></tr></thead><tbody>${positionRows}</tbody></table></div></section><section class="panel"><div class="panel-head"><div><h2>Biggest misses</h2><p>Most recent completed GW ${scored[scored.length-1].gw}.</p></div></div>${[...scored[scored.length-1].rows].sort((a,b)=>Math.abs(b.error)-Math.abs(a.error)).slice(0,5).map(p=>`<div class="summary-item"><span>${esc(p.name)} · ${p.position}</span><b>${num(p.xp)} xP → ${num(p.actual,0)} pts <span class="${p.error>=0?'accent':'danger'}">(${signed(p.error)})</span></b></div>`).join('')}</section></div>`:''}
 <section class="panel"><div class="panel-head"><div><h2>Learning lab</h2><p>Evaluate a basic bias correction without changing the current forecast formula.</p></div><span class="mini-tag">HOLDOUT TEST</span></div>
 ${calibration?`<div class="review-metrics"><div><small>Training-derived xP multiplier</small><b>${num(calibration.factor,3)}×</b></div><div><small>Original validation MAE</small><b>${num(calibration.baseMAE,2)}</b></div><div><small>Adjusted validation MAE</small><b>${num(calibration.adjMAE,2)}</b></div></div><p class="fineprint">Trained only on earlier saved gameweeks, tested on separate GW ${calibration.heldout.join(' and ')} results. ${calibration.improved?'Promising candidate for further testing, NOT automatically applied.':'No reliable validation improvement yet; keep the original formula.'}</p>`:
 `<p class="muted">We need at least <b>5 completed, pre-deadline gameweek forecasts</b> before testing a basic calibration: 3+ earlier weeks to fit a correction and the last 2 weeks to test it. After that we can tune form, fixture and minutes factors if the evidence supports it.</p>`}
 <p class="fineprint">No hindsight backfill; current-season historical points without historical input snapshots are not valid evidence of predictive accuracy. Save an export of these records if changing phone or browser.</p>
 <button id="export-forecasts" class="subtle-btn">Export forecast history (.json)</button>
 </section>`;
}
function signed(x){return (x>0?'+':'')+num(x,2);}
function wireAccuracy(){
 $('save-forecast')?.addEventListener('click',()=>{
  const gw=S.data.gameweeks[0].id;
  S.resultsStatus=captureForecast(gw,true)?`Saved GW ${gw} before the deadline, including your current local transfer plans.`:'Cannot save: deadline passed or squad unavailable.';
  render();
 });
 $('check-results')?.addEventListener('click',async()=>{S.resultsStatus='Checking FPL for verified results…';render();await fetchFinalResults();render();});
 $('export-forecasts')?.addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify({app:'FPL IQ',format:1,team:S.data.team_id,created:new Date().toISOString(),forecasts:S.forecasts},null,2)],{type:'application/json'});
  const href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download=`fpl-iq-forecasts-${S.data.team_id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(href),30000);
 });
}

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
  const all=S.data.players, roster=myPlayers(), owned=new Set(roster.map(r=>r.element)), bank=availableBank(), weights=[1,.88,.78,.66,.55];
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
function overallPosition(){
  // The overall-rank fraction is the user's approximate top-percentile,
  // among all teams registered this season (including inactive teams).
  const rank = S.data?.entry?.summary_overall_rank;
  const count = S.data?.total_players;
  if (!Number.isSafeInteger(rank) || rank < 1 || !Number.isSafeInteger(count) || count < 1 || rank > count) {
    return {label:'—',detail:'Overall rank or manager count unavailable'};
  }
  const pct = 100 * rank / count;
  const label = pct < 0.1 ? 'Top <0.1%' : `Top ${pct.toFixed(1)}%`;
  return {label,detail:`Rank ${rank.toLocaleString('en-GB')} of ${count.toLocaleString('en-GB')} managers`};
}
function stats(){
  const p=plan(),a=p[0];const rating=teamRating(a.total),standing=overallPosition();
  return `<div class="stats">
    <article class="stat highlight"><div class="stat-label">Squad rating <span>✦</span></div><div class="stat-number">${rating}<em> / 100</em></div><div class="stat-foot">Heuristic, not trained AI · next GW</div></article>
    <article class="stat"><div class="stat-label">GW ${a.gw} projection <span>↗</span></div><div class="stat-number">${num(a.total)}<em> pts</em></div><div class="stat-foot">Optimised XI + captain</div></article>
    <article class="stat"><div class="stat-label">Next 5 gameweeks <span>◫</span></div><div class="stat-number">${num(p.reduce((s,x)=>s+x.total,0),0)}<em> pts</em></div><div class="stat-foot">Modelled starting XI each week</div></article>
    <article class="stat"><div class="stat-label">Overall position <span>🏆</span></div><div class="stat-number position-number">${standing.label}</div><div class="stat-foot">${standing.detail}</div></article>
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
  return stats()+planNotice()+`<div class="grid"><section class="panel"><div class="panel-head"><div><h2>5-gameweek projection</h2><p>Expected points including captain, with optimal legal lineups.</p></div><span class="mini-tag">NEXT 5 GWs</span></div>${bars()}</section>
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
function squad(){const l=bestXI(myPlayers(),GW());return planNotice()+stats()+gwSwitch()+`<div class="grid"><section class="panel"><div class="panel-head"><div><h2>Best XI for GW ${GW()}</h2><p>Model-selected ${l.formation} — does not change your real FPL lineup.</p></div><span class="mini-tag">${num(l.total)} xP</span></div>${pitch(GW())}</section><section class="panel"><div class="panel-head"><div><h2>Your 15 players</h2><p>Upcoming matchups, estimated points and availability.</p></div></div>${squadTable()}</section></div>`;}
function planner(){const p=plan(),l=bestXI(myPlayers(),GW());return planNotice()+gwSwitch()+stats()+`<div class="grid"><section class="panel"><div class="panel-head"><div><h2>Gameweek ${GW()} plan</h2><p>Review the automatically selected lineup and captain.</p></div><span class="mini-tag">${esc(l.formation)}</span></div>${pitch(GW())}</section><section class="panel"><div class="panel-head"><div><h2>Your GW ${GW()} checklist</h2><p>Fixtures and choices based on published squad data.</p></div></div><div class="summary-list"><div class="summary-item"><span>Expected total incl. captain</span><b class="accent">${num(l.total)} xP</b></div><div class="summary-item"><span>Best captain</span><b>${l.captain?iname(l.captain):'—'}</b></div><div class="summary-item"><span>Vice-captain</span><b>${l.vice?iname(l.vice):'—'}</b></div><div class="summary-item"><span>Best formation</span><b>${l.formation}</b></div><div class="summary-item"><span>Blank fixtures in squad</span><b>${myPlayers().filter(r=>!fixtureList(r.p,GW()).length).length}</b></div><div class="summary-item"><span>Double fixtures in squad</span><b>${myPlayers().filter(r=>fixtureList(r.p,GW()).length>1).length}</b></div></div><p class="fineprint">Model assumes fit players with normal minutes and uses fixture difficulty, form and season statistics. It does not know team news not recorded by FPL.</p></section></div><section class="panel"><div class="panel-head"><div><h2>5-week fixture planning</h2><p>Compare modelled team strength and the best captain across upcoming deadlines.</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Gameweek</th><th>Projected XI</th><th>Captain</th><th>Captain xP</th><th>Formation</th><th>Deadline (UK)</th></tr></thead><tbody>${p.map(x=>`<tr><td><b>GW ${x.gw}</b></td><td class="accent"><b>${num(x.total)} pts</b></td><td>${x.captain?iname(x.captain):'—'}</td><td>${x.captain?num(xp(x.captain.p,x.gw)):'—'}</td><td>${x.formation}</td><td>${new Date(x.deadline).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'})}</td></tr>`).join('')}</tbody></table></div></section>`;}
function planNotice(){
  if(!S.savedTransfers.length)return '';
  return `<div class="plan-notice"><strong>✓ Local transfer plan active</strong><span>${S.savedTransfers.map(t=>`${esc(playerName(player(t.out)))} → ${esc(playerName(player(t.incoming)))}`).join(' · ')}. Your projections include these players, even before the public FPL squad updates.</span><button class="plan-jump" data-go-transfers="1">Manage plans ↗</button></div>`;
}
function optionLabel(p){return `${playerName(p)} (${clubName(p)} · ${position(p)} · ${money(toN(p.now_cost)/10)})`;}
function incomingCandidates(){
 const outgoing=myPlayers().find(r=>r.element===Number(S.draft.out));
 if(!outgoing)return [];
 const owned=new Set(myPlayers().map(r=>r.element));
 return S.data.players.filter(p=>p.element_type===outgoing.p.element_type && !owned.has(p.id)).sort((a,b)=>playerName(a).localeCompare(playerName(b)));
}
function normalise(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function transferOptions(){
 const q=normalise(S.draft.query);
 let matches=incomingCandidates().filter(p=>!q || normalise(`${playerName(p)} ${clubName(p)} ${p.first_name||''} ${p.second_name||''}`).includes(q));
 return `<option value="">${matches.length?`Select player (${matches.length} match${matches.length===1?'':'es'})`:'No matching players'}</option>`+matches.slice(0,150).map(p=>`<option value="${p.id}" ${Number(S.draft.incoming)===p.id?'selected':''}>${esc(optionLabel(p))}</option>`).join('');
}
function reviews(){
 const v=S.review;if(!v)return '';
 if(!v.ok)return `<div class="review-box warning"><h3>Check this transfer</h3>${v.errors.map(e=>`<p>• ${esc(e)}</p>`).join('')}</div>`;
 return `<div class="review-box ${v.tone}"><div class="review-header"><div><span class="mini-tag ${v.tone==='good'?'':'muted-tag'}">${esc(v.verdict)}</span><h3>${esc(playerName(v.old))} → ${esc(playerName(v.incoming))}</h3></div><b class="review-gain">${v.net>=0?'+':''}${num(v.net)}<small>5-GW net weighted xP</small></b></div>
 <div class="review-metrics"><div><small>Next GW XI change</small><b>${v.afterNext-v.beforeNext>=0?'+':''}${num(v.afterNext-v.beforeNext)} xP</b></div><div><small>5-GW squad change</small><b>${v.gain>=0?'+':''}${num(v.gain)} xP</b></div><div><small>Hit cost</small><b>${v.hit?'-4 pts':'0 pts'}</b></div><div><small>Estimated bank after</small><b>${money(v.bankAfter)}</b></div></div>
 <p class="review-context">${v.net>=1.5?'Our model favours the move across five weeks, after any selected hit. Compare injuries, likely starts, and future team changes before deciding.':v.net>=-1.5?'This move is close on projected points. Price, minutes and longer-term plans could outweigh the small difference.':'Our model expects your squad to score fewer points with this change. A specific injury or news update could still justify it.'}</p>
 <div class="review-warnings">${v.warnings.map(w=>`<p>• ${esc(w)}</p>`).join('')}</div>
 <button class="primary-btn confirm-btn" id="confirm-transfer">${S.draft.status==='made'?'Save as already made in FPL':'Confirm planned transfer (local only)'}</button>
 <p class="fineprint">Saving changes FPL IQ projections only. It does not buy or sell anyone in Fantasy Premier League.</p></div>`;
}
function activePlanCards(){
 if(!S.savedTransfers.length)return '<p class="muted">No local transfer plans yet. Add one below to update your projected squad before the public FPL data catches up.</p>';
 return S.savedTransfers.map((t,i)=>`<div class="saved-transfer"><div><strong>${esc(playerName(player(t.out)))} <span class="accent">→</span> ${esc(playerName(player(t.incoming)))}</strong><small>${t.status==='made'?'Marked already made in FPL':'Planned only'} · saved locally · ${t.hit?'-4 selected':''}</small></div><button class="subtle-btn" data-remove-plan="${i}" aria-label="Remove transfer ${i+1}">Remove</button></div>`).join('');
}
function metricsGuide(){return `<details class="panel metrics-guide"><summary><strong>How are xP and weighted xP calculated?</strong><span>Show formula ↓</span></summary>
 <p><b>Base xP</b> = 42% × FPL form + 36% × season points/game + 22% × FPL ep_next (or fallback). This base is capped between 0.3 and 12.</p>
 <p><b>Next GW xP</b> = base xP × FPL fixture difficulty factor × availability factor × minutes factor, summed across each fixture in a double GW (zero for blank weeks).</p>
 <p><b>Fixture factors:</b> FDR 1 ×1.30, 2 ×1.16, 3 ×1.00, 4 ×0.85, 5 ×0.72. Availability depends on FPL status/chance of playing. Minutes factor = season minutes ÷ (last published GW × 80), clipped between 0.40 and 1.00.</p>
 <p><b>5-GW weighted xP:</b> GW1 ×1.00 + GW2 ×0.88 + GW3 ×0.78 + GW4 ×0.66 + GW5 ×0.55. Transfer evaluations compare the <i>best legal XI plus an extra captain score</i> with and without the transfer, minus any selected transfer hit.</p>
 <p><b>Squad rating /100:</b> round(28 + 0.95 × next-GW XI-and-captain projection), clipped to 1–99. This rating scale is arbitrary and not benchmarked against other managers.</p>
 <p class="fineprint">All coefficients are experimental hand-set heuristics, not calibrated probabilities or a trained AI model. Public player price may not equal your selling price; the model also does not incorporate independent odds, lineup forecasts, price change risk or full transfer opportunity cost.</p>
 </details>`;}
function transfers(){const ss=suggestions(),roster=myPlayers().slice().sort((a,b)=>a.p.element_type-b.p.element_type||playerName(a.p).localeCompare(playerName(b.p)));
 return `<section class="panel"><div class="panel-head"><div><h2>Your transfer plans</h2><p>Save transfers before they appear in public FPL data. These are private to this browser on this device.</p></div><span class="mini-tag">LOCAL ONLY</span></div>
 ${S.notice?`<p class="plan-alert">${esc(S.notice)}</p>`:''}
 ${activePlanCards()}
 </section>
 <section class="panel"><div class="panel-head"><div><h2>Evaluate a transfer</h2><p>Pick an outgoing and incoming player to see whether your expected squad points improve.</p></div><span class="mini-tag">5 GW ANALYSIS</span></div>
 <div class="transfer-form"><label>Player OUT<select id="transfer-out"><option value="">Choose a squad player</option>${roster.map(r=>`<option value="${r.element}" ${Number(S.draft.out)===r.element?'selected':''}>${esc(optionLabel(r.p))}</option>`).join('')}</select></label>
 <label>Search incoming player<input id="transfer-search" type="search" placeholder="e.g. Joao Pedro" autocomplete="off" value="${esc(S.draft.query)}" /></label>
 <label>Player IN<select id="transfer-in" ${S.draft.out?'':'disabled'}>${transferOptions()}</select></label>
 <div class="transfer-method"><label class="radio-row"><input type="radio" name="transfer-status" value="made" ${S.draft.status==='made'?'checked':''}> I've already made this transfer in FPL</label>
 <label class="radio-row"><input type="radio" name="transfer-status" value="planned" ${S.draft.status==='planned'?'checked':''}> I'm considering this transfer</label></div>
 <label id="transfer-hit-wrap" class="${S.draft.status==='made'?'hidden':''}">Points hit (if any)<select id="transfer-hit"><option value="0" ${!S.draft.hit?'selected':''}>No hit (free transfer)</option><option value="4" ${S.draft.hit===4?'selected':''}>-4 point hit</option></select></label>
 <button id="review-transfer" class="primary-btn" type="button">Evaluate transfer →</button></div>
 ${reviews()}
 <p class="fineprint">You can save several transfers. FPL IQ updates the starting XI, captain, projections and chip suggestions locally. Plans are reconciled against new published squads after refresh. Private plans are not synced across devices, browsers or a newly installed app.</p>
 </section>
 <div class="grid"><section class="panel"><div class="panel-head"><div><h2>Transfer optimiser</h2><p>Simple individual five-week weighted xP ideas for comparison.</p></div><span class="mini-tag">WATCHLIST</span></div>
 ${ss.length?ss.map(x=>`<div class="transfer-card"><div class="transfer-player"><strong class="danger">${esc(playerName(x.old.p))}</strong><small>OUT · ${esc(clubName(x.old.p))} · ${position(x.old.p)}</small></div><div class="transfer-arrow">→</div><div class="transfer-player"><strong class="accent">${esc(playerName(x.p))}</strong><small>IN · ${esc(clubName(x.p))} · ${position(x.p)}</small></div><div class="gain">+${num(x.gain)}<small>individual weighted xP</small></div><button class="subtle-btn" data-try-out="${x.old.element}" data-try-in="${x.p.id}">Evaluate</button></div>`).join(''):'<p class="muted">No clear upgrades found using approximate public prices.</p>'}
 <p class="note">Suggestions are a shortlist, not transfer instructions. Evaluate them above to compare full-XI gains, captain changes and potential hits. Costs use listed market prices, not your exact selling price.</p></section>
 <section class="panel"><div class="panel-head"><div><h2>Before you confirm</h2><p>The planner does not have your private FPL account details.</p></div></div>
 <div class="reco"><div class="reco-icon">1</div><div><h3>Verify selling price and bank</h3><p>FPL IQ estimates affordability from the public squad. Confirm the actual figures in FPL.</p></div></div>
 <div class="reco"><div class="reco-icon">2</div><div><h3>Check predicted minutes and news</h3><p>A promising statistical move can be undermined by rotation, injury or late news.</p></div></div>
 <div class="reco"><div class="reco-icon">3</div><div><h3>Tell us about a hit</h3><p>Select a -4 hit if appropriate. We subtract it from the transfer assessment.</p></div></div>
 <div class="reco"><div class="reco-icon">4</div><div><h3>Official FPL remains separate</h3><p>Saving a plan here does not make a transfer on the official site.</p></div></div>
 </section></div>${metricsGuide()}`;
}
function wireTransfers(){
 const out=$('transfer-out');if(!out)return;
 out.addEventListener('change',()=>{S.draft.out=out.value;S.draft.incoming='';S.draft.query='';S.review=null;render();});
 const search=$('transfer-search'),sel=$('transfer-in');
 search.addEventListener('input',()=>{S.draft.query=search.value;S.draft.incoming='';S.review=null;sel.innerHTML=transferOptions();});
 sel.addEventListener('change',()=>{S.draft.incoming=sel.value;S.review=null;});
 document.querySelectorAll('input[name="transfer-status"]').forEach(r=>r.addEventListener('change',()=>{if(r.checked){S.draft.status=r.value;S.review=null;$('transfer-hit-wrap').classList.toggle('hidden',r.value==='made');}}));
 $('transfer-hit').addEventListener('change',e=>{S.draft.hit=Number(e.target.value)===4?4:0;S.review=null;});
 $('review-transfer').addEventListener('click',()=>{S.review=evaluateTransfer(Number(S.draft.out),Number(S.draft.incoming),S.draft.status,S.draft.hit);render();$('confirm-transfer')?.scrollIntoView({block:'nearest',behavior:'smooth'});});
 $('confirm-transfer')?.addEventListener('click',()=>{
  const result=evaluateTransfer(Number(S.draft.out),Number(S.draft.incoming),S.draft.status,S.draft.hit);
  if(!result.ok){S.review=result;render();return;}
  S.savedTransfers.push({out:Number(S.draft.out),incoming:Number(S.draft.incoming),status:S.draft.status,hit:S.draft.status==='planned'?S.draft.hit:0,createdAt:new Date().toISOString()});
  persistSaved();if(S.data.gameweeks[0])captureForecast(S.data.gameweeks[0].id,true);S.notice='Transfer saved. Your projected squad, captain and chip analysis now include this player.';
  S.draft={out:'',incoming:'',query:'',status:'made',hit:0};S.review=null;render();
 });
 document.querySelectorAll('[data-remove-plan]').forEach(b=>b.addEventListener('click',()=>{S.savedTransfers.splice(Number(b.dataset.removePlan),1);persistSaved();if(S.data.gameweeks[0])captureForecast(S.data.gameweeks[0].id,true);S.review=null;S.notice='Saved transfer removed.';render();}));
 document.querySelectorAll('[data-try-out]').forEach(b=>b.addEventListener('click',()=>{S.draft={out:b.dataset.tryOut,incoming:b.dataset.tryIn,query:'',status:'planned',hit:0};S.review=evaluateTransfer(Number(S.draft.out),Number(S.draft.incoming),'planned',0);render();}));
}

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
function render(){if(!S.data)return;const body={overview,squad,planner,transfers,chips,accuracy}[S.tab]();$('content').innerHTML=body;document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===S.tab));document.querySelectorAll('[data-gw]').forEach(b=>b.addEventListener('click',()=>{S.gw=Number(b.dataset.gw);render();}));document.querySelectorAll('[data-go-transfers]').forEach(b=>b.addEventListener('click',()=>{S.tab='transfers';render();}));if(S.tab==='transfers')wireTransfers();if(S.tab==='accuracy')wireAccuracy();}

async function load(demo=false){
 if(S.loading)return;
 S.loading=true;$('error').classList.add('hidden');$('loading').classList.remove('hidden');$('content').classList.add('hidden');$('sample-banner').classList.add('hidden');
 $('connection-label').innerHTML='<i></i>Connecting';$('connection-label').classList.remove('connected');
 const entry=$('entry-id').value.trim();
 $('fpl-link').href=`https://fantasy.premierleague.com/en/entry/${encodeURIComponent(entry)}/history`;
 try{
   const r=await fetch(`/api/data?${demo?'demo=1':'entry='+encodeURIComponent(entry)}`);const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not load FPL data');
   S.data=data;S.gw=data.gameweeks[0].id;S.savedTransfers=readSaved();S.notice='';syncSaved();S.draft={out:'',incoming:'',query:'',status:'made',hit:0};S.review=null;S.tab='overview';initialiseForecasts();
   $('greeting').innerHTML=(data.mode==='demo'?'Demo team':esc(data.entry.name||'Your FPL team'))+'<span class="period">.</span>';
   $('intro').textContent=data.mode==='demo'?'Explore all features using clearly fictional data.':'Live published FPL squad • GW '+data.published_gw+' last visible • '+data.gameweeks.length+' upcoming gameweeks';
   $('connection-label').innerHTML='<i></i>'+(data.mode==='demo'?'Demo mode':'Public data loaded');$('connection-label').classList.add('connected');
   $('sample-banner').classList.toggle('hidden',data.mode!=='demo');
   $('content').classList.remove('hidden');render();fetchFinalResults();
 }catch(err){$('error').classList.remove('hidden');$('error').innerHTML=`<b>Connection not available.</b> ${esc(err.message)}<div style="margin-top:8px">You can still explore the working dashboard with <button id="try-demo">fictional demo data →</button></div>`;$('try-demo').onclick=()=>load(true);$('connection-label').innerHTML='<i></i>Offline';
 }finally{S.loading=false;$('loading').classList.add('hidden');}
}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{if(!S.data)return;S.tab=t.dataset.tab;render();window.scrollTo({top:0,behavior:'smooth'});});
$('connect').onclick=()=>load(false);
$('refresh').onclick=()=>load(S.data?.mode==='demo');
$('live-retry').onclick=()=>load(false);
$('entry-id').addEventListener('keydown',e=>{if(e.key==='Enter')load(false);});
const params=new URLSearchParams(location.search);if(params.get('demo')==='1')load(true);else load(false);
