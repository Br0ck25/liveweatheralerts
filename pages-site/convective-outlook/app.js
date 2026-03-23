const dom = {
  updatedAt: document.getElementById('updatedAt'),
  outlookCount: document.getElementById('outlookCount'),
  loadWarning: document.getElementById('loadWarning'),
  outlookGrid: document.getElementById('outlookGrid'),
  outlookEmpty: document.getElementById('outlookEmpty'),
};

function escHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || 'Unknown');
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function riskClass(risk) {
  const r = String(risk || '').toLowerCase();
  if (r === 'high') return 'risk-high';
  if (r === 'moderate') return 'risk-moderate';
  if (r === 'enhanced') return 'risk-enhanced';
  if (r === 'slight') return 'risk-slight';
  if (r === 'marginal') return 'risk-marginal';
  if (r === 'none') return 'risk-none';
  if (r === 'general') return 'risk-none';
  return 'risk-none';
}

function simpleImportance(risk) {
  const r = String(risk || '').toLowerCase();
  if (r === 'high' || r === 'moderate') return 'Very Important';
  if (r === 'enhanced' || r === 'slight') return 'Important';
  if (r === 'marginal') return 'Watch Closely';
  if (r === 'none') return 'Low Concern';
  return 'Check Updates';
}

function renderOutlooks(outlooks) {
  if (!Array.isArray(outlooks) || outlooks.length === 0) {
    dom.outlookGrid.innerHTML = '';
    dom.outlookEmpty.hidden = false;
    return;
  }

  dom.outlookEmpty.hidden = true;
  const cards = outlooks.map((item) => {
    const dayLabel = Number(item.day) > 0 ? `Day ${item.day}` : 'Latest Outlook';
    const cardRiskClass = riskClass(item.risk);
    const urgency = item.urgency || 'Keep checking weather updates.';
    const summary = item.summary || 'No summary text is available.';
    const importance = simpleImportance(item.risk);
    const mapImageUrl = String(item.mapImageUrl || '').trim();
    const mapImageAlt = String(item.mapImageAlt || `${dayLabel} outlook map`).trim();
    const mapMarkup = mapImageUrl
      ? `
          <figure class="map-box">
            <img class="outlook-map" src="${escHtml(mapImageUrl)}" alt="${escHtml(mapImageAlt)}" loading="lazy" decoding="async" />
            <figcaption>
              <a class="map-link" href="${escHtml(mapImageUrl)}" target="_blank" rel="noopener noreferrer">Open map full size</a>
            </figcaption>
          </figure>
        `
      : '';

    return `
      <article class="outlook-card ${escHtml(cardRiskClass)}">
        <header>
          <span class="day-badge">${escHtml(dayLabel)}</span>
          <h2>${escHtml(item.riskLabel || 'Risk Not Clear')} - ${escHtml(importance)}</h2>
          <p class="published">Published: ${escHtml(formatDateTime(item.publishedAt))}</p>
        </header>
        <div class="outlook-body">
          <div class="kid-box">
            <h3>What this means in simple words</h3>
            <p>${escHtml(urgency)}</p>
          </div>
          ${mapMarkup}
          <div class="summary-box">
            <h3>Forecaster summary</h3>
            <p>${escHtml(summary)}</p>
          </div>
          <a class="source-link" href="${escHtml(item.link || '#')}" target="_blank" rel="noopener noreferrer">Read full SPC outlook</a>
        </div>
      </article>
    `;
  }).join('');

  dom.outlookGrid.innerHTML = cards;
}

async function fetchOutlookData() {
  const response = await fetch('/api/convective-outlook', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Outlook API failed (${response.status})`);
  }
  return await response.json();
}

async function boot() {
  try {
    const payload = await fetchOutlookData();
    const outlooks = Array.isArray(payload.outlooks) ? payload.outlooks : [];
    dom.outlookCount.textContent = String(outlooks.length);
    dom.updatedAt.textContent = formatDateTime(payload.updatedAt);
    renderOutlooks(outlooks);
  } catch (err) {
    dom.updatedAt.textContent = 'Unavailable';
    dom.outlookCount.textContent = '0';
    dom.loadWarning.hidden = false;
    dom.loadWarning.textContent = `Could not load convective outlook data: ${String(err)}`;
    dom.outlookGrid.innerHTML = '';
    dom.outlookEmpty.hidden = false;
    dom.outlookEmpty.querySelector('h2').textContent = 'Unable to load convective outlook';
    dom.outlookEmpty.querySelector('p').textContent = 'Please refresh in a minute.';
  }
}

boot();
