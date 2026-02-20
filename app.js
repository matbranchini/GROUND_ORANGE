const STORAGE_KEY='go_portfolio_overrides_v1';
const monthFmt=new Intl.DateTimeFormat('it-IT',{year:'numeric',month:'2-digit'});
const eurFmt=new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'});
const pctFmt=new Intl.NumberFormat('it-IT',{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2});
const d=(s)=>new Date(s+'T00:00:00');
const fmtE=(v)=>eurFmt.format(Number(v||0));
const fmtP=(v)=>pctFmt.format(Number(v||0));

function loadOverrides(){
  try{const raw=localStorage.getItem(STORAGE_KEY);return raw?JSON.parse(raw):{transactions:[],market_snapshots:[]};}
  catch{return {transactions:[],market_snapshots:[]};}
}
function saveOverrides(o){localStorage.setItem(STORAGE_KEY,JSON.stringify(o));}
function mergeData(base,ov){
  const out=structuredClone(base);
  out.transactions=[...(base.transactions||[]),...(ov.transactions||[])].sort((a,b)=>d(a.date)-d(b.date));
  out.market_snapshots=[...(base.market_snapshots||[]),...(ov.market_snapshots||[])].sort((a,b)=>d(a.date)-d(b.date));
  return out;
}

function perfDerived(snaps){
  let realized=0; const out=[];
  for(const s of snaps){
    realized += Number(s.dividends_net||0)+Number(s.cap_gains_net||0);
    const A=Number(s.contrib_cum||0); const G=Number(s.market_value_gross||0);
    const H=G-A; const I=A?H/A:0;
    out.push({...s, realized_cum_net:realized, realized_pct:A?realized/A:0, invested_cum:A+realized, perf_eur:H, perf_pct:I});
  }
  return out;
}

function groupContrib(transactions){
  const map=new Map();
  for(const t of transactions){
    if(t.type!=='contribution') continue;
    const k=monthFmt.format(d(t.date));
    map.set(k,(map.get(k)||0)+Number(t.amount||0));
  }
  return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
}

function investorTotals(investors,transactions){
  const totals=new Map(investors.map(i=>[i.id,0]));
  for(const t of transactions){
    if(t.type!=='contribution') continue;
    totals.set(t.investor_id,(totals.get(t.investor_id)||0)+Number(t.amount||0));
  }
  const totalFund=[...totals.values()].reduce((a,b)=>a+b,0);
  return {totals,totalFund};
}

function initTabs(){
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
}

let chartValue, chartPerf, chartContrib, chartDividends;
let fullPerfData = [];
let currentFilters = { value: '1Y', perf: '1Y', dividends: '1Y' };

function filterByRange(data, range) {
  if (range === 'MAX' || !data.length) return data;
  const now = new Date();
  let cutoff;
  switch(range) {
    case '1M': cutoff = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()); break;
    case 'YTD': cutoff = new Date(now.getFullYear(), 0, 1); break;
    case '1Y': cutoff = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()); break;
    case '3Y': cutoff = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate()); break;
    case '5Y': cutoff = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()); break;
    default: return data;
  }
  return data.filter(x => d(x.date) >= cutoff);
}

function renderValueChart(perf) {
  // Filter out yearly summary rows (period length = 4 like "2023", "2024")
  const monthlyOnly = perf.filter(x => !x.period || x.period.length !== 4);
  const filtered = filterByRange(monthlyOnly, currentFilters.value);
  const labels = filtered.map(x => x.date);
  chartValue?.destroy();
  chartValue = new Chart(document.getElementById('chartValue'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Contribuzioni CUM (A)', data: filtered.map(x => x.contrib_cum), borderWidth: 2 },
        { label: 'Valore Mercato (G)', data: filtered.map(x => x.market_value_gross), borderWidth: 2 }
      ]
    },
    options: { responsive: true, scales: { x: { display: false } } }
  });
}

function renderPerfChart(perf) {
  // Filter out yearly summary rows (period length = 4 like "2023", "2024")
  const monthlyOnly = perf.filter(x => !x.period || x.period.length !== 4);
  const filtered = filterByRange(monthlyOnly, currentFilters.perf);
  const labels = filtered.map(x => x.date);
  chartPerf?.destroy();
  chartPerf = new Chart(document.getElementById('chartPerf'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Performance % (I)', data: filtered.map(x => x.perf_pct * 100), borderWidth: 2 }
      ]
    },
    options: { responsive: true, scales: { x: { display: false }, y: { ticks: { callback: v => v + '%' } } } }
  });
}

function renderDividendsChart(perf) {
  // Get yearly records (period length = 4 means year only like "2023")
  const yearlyRecords = perf.filter(s => s.period && s.period.length === 4);
  
  // Get years that have yearly summaries
  const yearsWithSummary = new Set(yearlyRecords.map(s => s.period));
  
  // Calculate partial year from monthly data (for current year without summary)
  const monthlyRecords = perf.filter(s => s.period && s.period.length === 7); // "2026-01" format
  const partialYearMap = new Map();
  for (const s of monthlyRecords) {
    const year = s.period.substring(0, 4);
    if (!yearsWithSummary.has(year)) {
      partialYearMap.set(year, (partialYearMap.get(year) || 0) + Number(s.dividends_net || 0));
    }
  }
  
  // Combine yearly summaries + partial years
  let years = yearlyRecords.map(s => s.period);
  let yearlyDividends = yearlyRecords.map(s => Number(s.dividends_net || 0));
  
  // Add partial years (like 2026)
  for (const [year, div] of partialYearMap) {
    years.push(year);
    yearlyDividends.push(div);
  }
  
  // Sort by year
  const combined = years.map((y, i) => ({ year: y, div: yearlyDividends[i] })).sort((a, b) => a.year.localeCompare(b.year));
  years = combined.map(c => c.year);
  yearlyDividends = combined.map(c => c.div);
  
  // Calculate cumulative
  let cumDiv = 0;
  const cumDividends = yearlyDividends.map(v => {
    cumDiv += v;
    return cumDiv;
  });
  
  chartDividends?.destroy();
  chartDividends = new Chart(document.getElementById('chartDividends'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: 'Dividendi Anno (Netto)', data: yearlyDividends, borderWidth: 1, order: 2 },
        { label: 'Dividendi CUM (Netto)', data: cumDividends, type: 'line', borderWidth: 2, order: 1 }
      ]
    },
    options: { responsive: true, scales: { x: { display: true } } }
  });
}

function renderCharts(perf) {
  fullPerfData = perf;
  renderValueChart(perf);
  renderPerfChart(perf);
  renderDividendsChart(perf);
}

function initChartFilters() {
  document.querySelectorAll('.chart-filters').forEach(container => {
    const chartType = container.dataset.chart;
    container.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilters[chartType] = btn.dataset.range;
        if (chartType === 'value') renderValueChart(fullPerfData);
        else if (chartType === 'perf') renderPerfChart(fullPerfData);
        else if (chartType === 'dividends') renderDividendsChart(fullPerfData);
      });
    });
  });
}
function renderContribChart(grouped){
  chartContrib?.destroy();
  chartContrib=new Chart(document.getElementById('chartContrib'),{type:'bar',data:{labels:grouped.map(x=>x[0]),datasets:[
    {label:'Contribuzioni mese (somma)',data:grouped.map(x=>x[1])}
  ]},options:{responsive:true,scales:{x:{display:false}}}});
}

function renderSnapshotsTable(perf){
  const tbody=document.querySelector('#tableSnapshots tbody'); tbody.innerHTML='';
  // Filter out yearly summary rows (period length = 4 like "2023", "2024")
  const monthlyOnly = perf.filter(x => !x.period || x.period.length !== 4);
  for(const r of monthlyOnly.slice(-12).reverse()){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${r.date}</td><td>${fmtE(r.contrib_cum)}</td><td>${fmtE(r.dividends_net)}</td><td>${fmtE(r.cap_gains_net)}</td><td>${fmtE(r.market_value_gross)}</td><td>${fmtE(r.perf_eur)}</td><td>${fmtP(r.perf_pct)}</td>`;
    tbody.appendChild(tr);
  }
}
function renderPerfTable(perf){
  const tbody=document.querySelector('#tablePerf tbody'); tbody.innerHTML='';
  for(const r of perf){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${r.period||r.date}</td><td>${fmtE(r.contrib_cum)}</td><td>${fmtE(r.dividends_net)}</td><td>${fmtE(r.cap_gains_net)}</td><td>${fmtE(r.realized_cum_net)}</td><td>${fmtP(r.realized_pct)}</td><td>${fmtE(r.invested_cum)}</td><td>${fmtE(r.market_value_gross)}</td><td>${fmtE(r.perf_eur)}</td><td>${fmtP(r.perf_pct)}</td>`;
    tbody.appendChild(tr);
  }
}
function renderInvestorsTable(investors,totals,totalFund){
  const tbody=document.querySelector('#tableInvestors tbody'); tbody.innerHTML='';
  const sorted=[...investors].sort((a,b)=>(totals.get(b.id)||0)-(totals.get(a.id)||0));
  for(const inv of sorted){
    const t=totals.get(inv.id)||0;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${inv.name}</td><td>${fmtE(t)}</td><td>${fmtP(totalFund?t/totalFund:0)}</td>`;
    tbody.appendChild(tr);
  }
}
function fillInvestorSelect(investors){
  const sel=document.getElementById('contribInvestor'); sel.innerHTML='';
  for(const inv of investors){
    const o=document.createElement('option'); o.value=inv.id; o.textContent=inv.name; sel.appendChild(o);
  }
}
function renderJson(data){document.getElementById('jsonView').textContent=JSON.stringify(data,null,2);}

function renderAll(data){
  const perf=perfDerived(data.market_snapshots);
  if(perf.length){
    const last=perf[perf.length-1];
    document.getElementById('kpi-market').textContent=fmtE(last.market_value_gross);
    document.getElementById('kpi-contrib').textContent=fmtE(last.contrib_cum);
    document.getElementById('kpi-perf').textContent=fmtE(last.perf_eur);
    document.getElementById('kpi-perf-pct').textContent=fmtP(last.perf_pct);
    document.getElementById('kpi-realized').textContent=fmtE(last.realized_cum_net);
    // Performance tooltip calculation
    const A = Number(last.contrib_cum || 0);
    const G = Number(last.market_value_gross || 0);
    const H = G - A;
    document.getElementById('kpi-perf-tooltip').innerHTML = `
      <div class="kpi-tooltip-title">Calcolo Performance %</div>
      <div class="kpi-tooltip-row"><span>G (Valore Mercato):</span><span>${fmtE(G)}</span></div>
      <div class="kpi-tooltip-row"><span>A (Contribuzioni CUM):</span><span>${fmtE(A)}</span></div>
      <div class="kpi-tooltip-row"><span>H = G - A:</span><span>${fmtE(H)}</span></div>
      <div class="kpi-tooltip-row total"><span>I = H / A:</span><span>${fmtP(A ? H/A : 0)}</span></div>
    `;
    // Calculate totals for tooltip
    const totalDiv = data.market_snapshots.reduce((sum, s) => sum + Number(s.dividends_net || 0), 0);
    const totalCG = data.market_snapshots.reduce((sum, s) => sum + Number(s.cap_gains_net || 0), 0);
    document.getElementById('kpi-realized-tooltip').innerHTML = `
      <div class="kpi-tooltip-title">Dettaglio Ricavi Realizzati</div>
      <div class="kpi-tooltip-row"><span>Dividendi Netto:</span><span>${fmtE(totalDiv)}</span></div>
      <div class="kpi-tooltip-row"><span>Plusvalenze Netto:</span><span>${fmtE(totalCG)}</span></div>
      <div class="kpi-tooltip-row total"><span>Totale CUM:</span><span>${fmtE(totalDiv + totalCG)}</span></div>
      <div class="kpi-tooltip-note">Somma cumulativa di tutti i dividendi e plusvalenze nette dall'inizio</div>
    `;
    renderCharts(perf);
    renderSnapshotsTable(perf);
    renderPerfTable(perf);
  }
  const grouped=groupContrib(data.transactions);
  renderContribChart(grouped);
  const {totals,totalFund}=investorTotals(data.investors,data.transactions);
  renderInvestorsTable(data.investors,totals,totalFund);
  renderJson(data);
}

function wireForms(getData){
  document.getElementById('formContribution').addEventListener('submit',(e)=>{
    e.preventDefault();
    const ov=loadOverrides();
    ov.transactions=ov.transactions||[];
    ov.transactions.push({type:'contribution',investor_id:contribInvestor.value,date:contribDate.value,amount:Number(contribAmount.value),currency:'EUR',note:contribNote.value||''});
    saveOverrides(ov);
    renderAll(getData());
    e.target.reset();
  });
  document.getElementById('btnClearLocal').addEventListener('click',()=>{localStorage.removeItem(STORAGE_KEY);renderAll(getData(true));});
}

(async function(){
  initTabs();
  initChartFilters();
  const base=await fetch('data.json').then(r=>r.json());
  const getData=(reset=false)=> mergeData(base, reset?{transactions:[],market_snapshots:[]}:loadOverrides());
  const data=getData();
  fillInvestorSelect(data.investors);
  wireForms(getData);
  renderAll(data);
})();
