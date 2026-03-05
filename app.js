const STORAGE_KEY='go_portfolio_overrides_v1';
const monthFmt=new Intl.DateTimeFormat('it-IT',{year:'numeric',month:'2-digit'});
const eurFmt=new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'});
const pctFmt=new Intl.NumberFormat('it-IT',{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2});
const d=(s)=>new Date(s+'T00:00:00');
const fmtE=(v)=>eurFmt.format(Number(v||0));
const fmtP=(v)=>pctFmt.format(Number(v||0));

// Google Sheet ID per dati live
const GOOGLE_SHEET_ID = '1-3VnoZFcq42JWV0uzHbrP-aFe5mr8UfWfXsd6WwgYKE';

function parseCSVRow(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  
  for (let c = 0; c < line.length; c++) {
    const char = line[c];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseNumber(cellValue) {
  if (!cellValue || cellValue === '') return null;
  // Rimuovi virgolette e simboli
  let clean = cellValue.replace(/"/g, '').replace(/[€$£%\s]/g, '');
  // Formato italiano: "39.646,07871" -> 39646.07871 o "39646,07871" -> 39646.07871
  clean = clean.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
}

async function fetchGoogleSheetLiveData() {
  try {
    // Legge il foglio come CSV
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv`;
    const res = await fetch(sheetUrl);
    const csv = await res.text();
    
    // Parsa CSV - split per righe
    const lines = csv.split('\n');
    
    // Riga 30 = indice 29 (0-based)
    const targetRow = 29;
    if (lines.length <= targetRow) {
      console.error('Riga 30 non trovata, righe totali:', lines.length);
      return null;
    }
    
    const cells = parseCSVRow(lines[targetRow]);
    
    // I30 = indice 8 (Valore di Mercato LIVE)
    // K30 = indice 10 (Performance giornaliera in euro)
    const marketValue = parseNumber(cells[8]);     // I30
    const dailyPerfEur = parseNumber(cells[10]);   // K30
    
    console.log('Riga 30:', lines[targetRow]);
    console.log('I30 (index 8):', cells[8], '→', marketValue);
    console.log('K30 (index 10):', cells[10], '→', dailyPerfEur);
    
    return { marketValue, dailyPerfPct: dailyPerfEur };
  } catch(e) {
    console.error('Errore fetch Google Sheet:', e);
    return null;
  }
}

async function renderLive(contribCum) {
  document.getElementById('kpi-live-total').textContent = 'Caricamento...';
  
  const data = await fetchGoogleSheetLiveData();
  
  // Contribuzioni Totali (dal data.json)
  document.getElementById('kpi-live-contrib').textContent = fmtE(contribCum);
  
  if (data && data.marketValue) {
    // Valore di Mercato LIVE (I30)
    document.getElementById('kpi-live-total').textContent = fmtE(data.marketValue);
    
    // Performance LIVE TOTALE = (marketValue / contribCum) - 1
    if (contribCum && contribCum > 0) {
      const perfTotalPct = (data.marketValue / contribCum) - 1;
      const perfTotalEur = data.marketValue - contribCum;
      document.getElementById('kpi-live-perf').textContent = fmtP(perfTotalPct);
      document.getElementById('kpi-live-perf-eur').textContent = fmtE(perfTotalEur);
    }
    
    // Performance LIVE Giornaliera (K30 = ammontare in €, calcola % su I30)
    if (data.dailyPerfPct !== null && data.marketValue) {
      // K30 è l'ammontare in euro della performance giornaliera
      const dailyPerfEur = data.dailyPerfPct; // K30 è già in euro
      // Calcola percentuale: (K30 / I30) * 100
      const dailyPerfPct = (dailyPerfEur / data.marketValue);
      
      document.getElementById('kpi-live-daily').textContent = fmtP(dailyPerfPct);
      document.getElementById('kpi-live-daily-eur').textContent = fmtE(dailyPerfEur);
    }
    
    const now = new Date();
    document.getElementById('kpi-live-time').textContent = now.toLocaleString('it-IT');
  } else {
    // Fallback ai dati dell'ultimo snapshot
    document.getElementById('kpi-live-total').textContent = 'Dati non disponibili';
    document.getElementById('kpi-live-total').style.fontSize = '16px';
  }
}

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
    // Escludi i resoconti annuali (period length = 4 come "2023", "2024") dal calcolo realized
    const isYearlySummary = s.period && s.period.length === 4;
    if (!isYearlySummary) {
      realized += Number(s.dividends_net||0)+Number(s.cap_gains_net||0);
    }
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
  // Usa direttamente contributions_total e ownership_pct dagli investors
  const totals=new Map(investors.map(i=>[i.id, Number(i.contributions_total || 0)]));
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
let currentFilters = { value: '1Y', perf: '1Y', dividends: '5Y' };

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

function filterYearsByRange(range) {
  const now = new Date();
  let minYear;
  switch(range) {
    case '1Y': minYear = now.getFullYear() - 1; break;
    case '3Y': minYear = now.getFullYear() - 3; break;
    case '5Y': minYear = now.getFullYear() - 5; break;
    default: minYear = 0; // MAX
  }
  return minYear;
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
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: false } } }
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
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: false }, y: { ticks: { callback: v => v + '%' } } } }
  });
}

function renderDividendsChart(perf) {
  // Applica filtro temporale basato su anni
  const range = currentFilters.dividends || '5Y';
  const minYear = filterYearsByRange(range);
  
  // Get yearly records (period length = 4 means year only like "2023")
  const yearlyRecords = perf.filter(s => s.period && s.period.length === 4 && parseInt(s.period) >= minYear);
  
  // Get years that have yearly summaries
  const yearsWithSummary = new Set(yearlyRecords.map(s => s.period));
  
  // Calculate partial year from monthly data (for current year without summary)
  const monthlyRecords = perf.filter(s => s.period && s.period.length === 7); // "2026-01" format
  const partialYearDivMap = new Map();
  const partialYearCGMap = new Map();
  for (const s of monthlyRecords) {
    const year = s.period.substring(0, 4);
    if (!yearsWithSummary.has(year) && parseInt(year) >= minYear) {
      partialYearDivMap.set(year, (partialYearDivMap.get(year) || 0) + Number(s.dividends_net || 0));
      partialYearCGMap.set(year, (partialYearCGMap.get(year) || 0) + Number(s.cap_gains_net || 0));
    }
  }
  
  // Combine yearly summaries + partial years
  let years = yearlyRecords.map(s => s.period);
  let yearlyDividends = yearlyRecords.map(s => Number(s.dividends_net || 0));
  let yearlyCapGains = yearlyRecords.map(s => Number(s.cap_gains_net || 0));
  
  // Add partial years (like 2026)
  for (const [year, div] of partialYearDivMap) {
    years.push(year);
    yearlyDividends.push(div);
    yearlyCapGains.push(partialYearCGMap.get(year) || 0);
  }
  
  // Sort by year
  const combined = years.map((y, i) => ({ year: y, div: yearlyDividends[i], cg: yearlyCapGains[i] })).sort((a, b) => a.year.localeCompare(b.year));
  years = combined.map(c => c.year);
  yearlyDividends = combined.map(c => c.div);
  yearlyCapGains = combined.map(c => c.cg);
  
  // Calculate cumulative
  let cumDiv = 0;
  let cumCG = 0;
  const cumDividends = yearlyDividends.map(v => { cumDiv += v; return cumDiv; });
  const cumCapGains = yearlyCapGains.map(v => { cumCG += v; return cumCG; });
  const cumTotal = cumDividends.map((v, i) => v + cumCapGains[i]);
  
  chartDividends?.destroy();
  chartDividends = new Chart(document.getElementById('chartDividends'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: 'Dividendi Anno', data: yearlyDividends, backgroundColor: 'rgba(54, 162, 235, 0.7)', borderWidth: 1, order: 3 },
        { label: 'Plusvalenze Anno', data: yearlyCapGains, backgroundColor: 'rgba(255, 159, 64, 0.7)', borderWidth: 1, order: 3 },
        { label: 'Ricavi CUM (Netto)', data: cumTotal, type: 'line', borderColor: 'rgba(75, 192, 192, 1)', borderWidth: 2, order: 1, fill: false }
      ]
    },
    options: { 
      responsive: true, 
      maintainAspectRatio: false, 
      scales: { 
        x: { display: true, stacked: true }, 
        y: { stacked: true } 
      } 
    }
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
    const pct=Number(inv.ownership_pct||0);
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${inv.name}</td><td>${fmtE(t)}</td><td>${fmtP(pct)}</td>`;
    tbody.appendChild(tr);
  }
}
function fillInvestorSelect(investors){
  /* rimosso - select non più presente */
}
function renderJson(data){/* rimosso */}

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
    // Calculate totals for tooltip - solo dati mensili, escludi resoconti annuali
    const monthlySnapshots = data.market_snapshots.filter(s => !s.period || s.period.length !== 4);
    const totalDiv = monthlySnapshots.reduce((sum, s) => sum + Number(s.dividends_net || 0), 0);
    const totalCG = monthlySnapshots.reduce((sum, s) => sum + Number(s.cap_gains_net || 0), 0);
    document.getElementById('kpi-realized-tooltip').innerHTML = `
      <div class="kpi-tooltip-title">Dettaglio Ricavi Realizzati</div>
      <div class="kpi-tooltip-row"><span>Dividendi Netto:</span><span>${fmtE(totalDiv)}</span></div>
      <div class="kpi-tooltip-row"><span>Plusvalenze Netto:</span><span>${fmtE(totalCG)}</span></div>
      <div class="kpi-tooltip-row total"><span>Totale CUM:</span><span>${fmtE(totalDiv + totalCG)}</span></div>
      <div class="kpi-tooltip-note">Somma mensile di dividendi e plusvalenze (esclusi resoconti annuali)</div>
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
  /* rimosso - form non più presente */
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
  
  // Live tab - get contrib_cum from last snapshot
  const perf = perfDerived(data.market_snapshots);
  const contribCum = perf.length ? perf[perf.length-1].contrib_cum : 0;
  
  // Refresh button
  document.getElementById('refresh-live-btn')?.addEventListener('click', () => renderLive(contribCum));
  
  // Auto-load when switching to Live tab
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'live') {
        renderLive(contribCum);
      }
    });
  });
})();
