/* ============================================================
   DeepFeedAI Admin — Deployment Wizard
   ============================================================ */

function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Niche Templates ─────────────────────────────────────────
const NICHE_TEMPLATES = [
  {
    id: 'ai-tech', name: 'AI & Technology', icon: '\u{1F916}',
    description: 'Artificial intelligence, machine learning, and tech industry news',
    theme: 'Dark Cyan',
    tagline: 'Your daily signal in the AI noise',
    persona: 'You are a concise AI news analyst. Highlight key technical breakthroughs, business implications, and industry trends. Use clear language accessible to both technical and non-technical readers.',
    categories: [
      { name: 'LLMs', color: '#4F8EF7', writer: 'LLM Oracle' },
      { name: 'Image AI & Video', color: '#a78bfa', writer: 'Pixel' },
      { name: 'Research', color: '#34d399', writer: 'Lab Notes' },
      { name: 'Tools', color: '#fbbf24', writer: 'Tool Scout' },
      { name: 'Business', color: '#f472b6', writer: 'Deal Wire' },
      { name: 'Policy', color: '#60a5fa', writer: 'Policy Watch' },
      { name: 'CyberSecurity', color: '#ef4444', writer: 'ThreatBrief' },
      { name: 'Industry', color: '#94a3b8', writer: 'Signal' },
    ],
    sources: [
      { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
      { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
      { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
      { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
      { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/' },
      { name: 'AI News', url: 'https://www.artificialintelligence-news.com/feed/' },
      { name: 'Google AI Blog', url: 'https://blog.google/technology/ai/rss/' },
      { name: 'Anthropic News', url: 'https://www.anthropic.com/news/rss.xml' },
    ],
  },
  {
    id: 'crypto', name: 'Crypto & Web3', icon: '\u{1FA99}',
    description: 'Cryptocurrency, blockchain, DeFi, and Web3 news',
    theme: 'Dark Amber',
    tagline: 'Decentralized news, curated daily',
    persona: 'You are a crypto and blockchain analyst. Focus on market-moving developments, protocol upgrades, regulatory shifts, and DeFi innovations. Be factual and avoid hype.',
    categories: [
      { name: 'Bitcoin', color: '#f7931a', writer: 'Satoshi Signal' },
      { name: 'Ethereum', color: '#627eea', writer: 'Ether Eye' },
      { name: 'DeFi', color: '#34d399', writer: 'Yield Hunter' },
      { name: 'NFTs', color: '#a78bfa', writer: 'Mint' },
      { name: 'Regulation', color: '#ef4444', writer: 'RegWatch' },
      { name: 'Web3', color: '#60a5fa', writer: 'Chain Watch' },
    ],
    sources: [
      { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
      { name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
      { name: 'Decrypt', url: 'https://decrypt.co/feed' },
      { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
    ],
  },
  {
    id: 'healthcare', name: 'Healthcare Tech', icon: '\u{1FA7A}',
    description: 'Health technology, digital health, medtech, and biotech news',
    theme: 'Midnight Green',
    tagline: 'Where health meets innovation',
    persona: 'You are a healthcare technology analyst. Emphasize clinical impact, patient outcomes, regulatory milestones, and adoption challenges. Be precise with medical terminology.',
    categories: [
      { name: 'Digital Health', color: '#34d399', writer: 'MedPulse' },
      { name: 'Biotech', color: '#a78bfa', writer: 'Gene' },
      { name: 'Medical Devices', color: '#60a5fa', writer: 'Device Watch' },
      { name: 'AI in Healthcare', color: '#4F8EF7', writer: 'CareBot' },
      { name: 'Pharma', color: '#f472b6', writer: 'RxBrief' },
      { name: 'Policy', color: '#fbbf24', writer: 'Policy Rounds' },
    ],
    sources: [
      { name: 'STAT News', url: 'https://www.statnews.com/feed/' },
      { name: 'Fierce Healthcare', url: 'https://www.fiercehealthcare.com/rss/xml' },
      { name: 'MobiHealthNews', url: 'https://www.mobihealthnews.com/feed' },
      { name: 'Healthcare IT News', url: 'https://www.healthcareitnews.com/feed' },
    ],
  },
  {
    id: 'climate', name: 'Climate & Energy', icon: '\u{1F30D}',
    description: 'Climate tech, clean energy, sustainability, and environmental policy',
    theme: 'Midnight Green',
    tagline: 'Tracking the clean energy transition',
    persona: 'You are a climate and energy analyst. Focus on clean energy breakthroughs, policy developments, emissions data, and corporate sustainability commitments. Ground claims in data.',
    categories: [
      { name: 'Solar', color: '#fbbf24', writer: 'Sunbeam' },
      { name: 'Wind', color: '#60a5fa', writer: 'Gale Force' },
      { name: 'EVs', color: '#34d399', writer: 'Volt' },
      { name: 'Policy', color: '#ef4444', writer: 'Green Policy' },
      { name: 'Carbon', color: '#94a3b8', writer: 'Carbon Brief' },
      { name: 'Startups', color: '#a78bfa', writer: 'Green Signal' },
    ],
    sources: [
      { name: 'CleanTechnica', url: 'https://cleantechnica.com/feed/' },
      { name: 'Carbon Brief', url: 'https://www.carbonbrief.org/feed/' },
      { name: 'Electrek', url: 'https://electrek.co/feed/' },
      { name: 'Canary Media', url: 'https://www.canarymedia.com/feed' },
    ],
  },
  {
    id: 'fintech', name: 'Fintech', icon: '\u{1F4B3}',
    description: 'Financial technology, banking innovation, payments, and insurtech',
    theme: 'Dark Blue',
    tagline: 'The future of finance, today',
    persona: 'You are a fintech analyst. Cover payments innovation, banking disruption, regulatory changes, and funding rounds. Balance technical detail with business context.',
    categories: [
      { name: 'Payments', color: '#4F8EF7', writer: 'PayPulse' },
      { name: 'Banking', color: '#34d399', writer: 'BankShift' },
      { name: 'Lending', color: '#fbbf24', writer: 'LendLine' },
      { name: 'InsurTech', color: '#a78bfa', writer: 'RiskWire' },
      { name: 'RegTech', color: '#ef4444', writer: 'RegWatch' },
      { name: 'Startups', color: '#f472b6', writer: 'FinPulse' },
    ],
    sources: [
      { name: 'Finextra', url: 'https://www.finextra.com/rss/headlines.aspx' },
      { name: 'TechCrunch Fintech', url: 'https://techcrunch.com/category/fintech/feed/' },
      { name: 'Finovate', url: 'https://finovate.com/feed/' },
    ],
  },
  {
    id: 'cybersecurity', name: 'Cybersecurity', icon: '\u{1F6E1}\uFE0F',
    description: 'Infosec, threat intelligence, privacy, and security research',
    theme: 'Dark Red',
    tagline: 'Stay ahead of the threats',
    persona: 'You are a cybersecurity analyst. Focus on threat actors, vulnerabilities, attack techniques, and defensive strategies. Use precise technical terminology and assess real-world impact.',
    categories: [
      { name: 'Threats', color: '#ef4444', writer: 'ThreatBrief' },
      { name: 'Vulnerabilities', color: '#f97316', writer: 'CVE Watch' },
      { name: 'Privacy', color: '#a78bfa', writer: 'PrivacyDesk' },
      { name: 'Cloud Security', color: '#60a5fa', writer: 'CloudGuard' },
      { name: 'Compliance', color: '#fbbf24', writer: 'AuditTrail' },
      { name: 'Research', color: '#34d399', writer: 'SecLab' },
    ],
    sources: [
      { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
      { name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/' },
      { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml' },
      { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
    ],
  },
  {
    id: 'gaming', name: 'Gaming', icon: '\u{1F3AE}',
    description: 'Video games, esports, game development, and gaming industry news',
    theme: 'Dark Purple',
    tagline: 'Level up your news feed',
    persona: 'You are a gaming industry analyst. Cover game releases, studio news, esports, hardware, and industry trends. Be enthusiastic but factual.',
    categories: [
      { name: 'PC Gaming', color: '#4F8EF7', writer: 'Rig Check' },
      { name: 'Console', color: '#34d399', writer: 'Couch Co-op' },
      { name: 'Esports', color: '#ef4444', writer: 'Arena' },
      { name: 'Indie', color: '#a78bfa', writer: 'Pixel Heart' },
      { name: 'Industry', color: '#fbbf24', writer: 'Player One' },
      { name: 'Mobile', color: '#f472b6', writer: 'Tap' },
    ],
    sources: [
      { name: 'Kotaku', url: 'https://kotaku.com/rss' },
      { name: 'IGN', url: 'https://feeds.feedburner.com/ign/all' },
      { name: 'PC Gamer', url: 'https://www.pcgamer.com/rss/' },
      { name: 'Eurogamer', url: 'https://www.eurogamer.net/feed' },
    ],
  },
  {
    id: 'custom', name: 'Custom', icon: '\u{2699}\uFE0F',
    description: 'Start from scratch with your own categories and sources',
    theme: 'Charcoal',
    tagline: '',
    persona: '',
    categories: [{ name: 'General', color: '#94a3b8' }],
    sources: [],
  },
];

// ── Theme Presets (duplicated from settings-page.js for standalone use) ──
const THEME_PRESETS = [
  { name: 'Dark Blue',       accent: '#4F8EF7', bg: '#0d1117', bgCard: '#161b22', border: '#21262d', text: '#e6edf3', muted: '#8b949e', accentDim: '#2d5fbe' },
  { name: 'Dark Cyan',       accent: '#00d9ff', bg: '#0d0d0d', bgCard: '#161616', border: '#222222', text: '#f0f0f0', muted: '#888888', accentDim: '#0099b3' },
  { name: 'Dark Purple',     accent: '#a78bfa', bg: '#0f0b1a', bgCard: '#1a1525', border: '#2d2640', text: '#e8e0f0', muted: '#9990a8', accentDim: '#7c5fc4' },
  { name: 'Midnight Green',  accent: '#34d399', bg: '#0a1214', bgCard: '#121e22', border: '#1e3030', text: '#e0f0ec', muted: '#7da89e', accentDim: '#1f9e6f' },
  { name: 'Dark Rose',       accent: '#f472b6', bg: '#110a10', bgCard: '#1c1520', border: '#2e2030', text: '#f0e4ec', muted: '#a090a0', accentDim: '#b8508a' },
  { name: 'Dark Amber',      accent: '#fbbf24', bg: '#111009', bgCard: '#1c1a12', border: '#302a1a', text: '#f0ece0', muted: '#a09880', accentDim: '#b8880e' },
  { name: 'Charcoal',        accent: '#60a5fa', bg: '#121212', bgCard: '#1e1e1e', border: '#2a2a2a', text: '#e0e0e0', muted: '#909090', accentDim: '#3b7ad8' },
  { name: 'Dark Red',        accent: '#ef4444', bg: '#110d0d', bgCard: '#1c1616', border: '#2e2020', text: '#f0e6e6', muted: '#a09090', accentDim: '#b83030' },
  { name: 'Dracula',         accent: '#bd93f9', bg: '#282a36', bgCard: '#2e303e', border: '#44475a', text: '#f8f8f2', muted: '#6272a4', accentDim: '#9466d8' },
  { name: 'Nord',            accent: '#88c0d0', bg: '#2e3440', bgCard: '#3b4252', border: '#434c5e', text: '#eceff4', muted: '#7b88a1', accentDim: '#5e96a8' },
];

// ── State ────────────────────────────────────────────────────
let currentStep = 1;
let selectedNiche = null;
let selectedTheme = null;
let wizardSources = []; // { name, url, checked, status }

// ── Step navigation ──────────────────────────────────────────
function goToStep(step) {
  if (step < 1 || step > 4) return;
  currentStep = step;
  document.querySelectorAll('.wizard-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('step' + step).classList.add('active');

  // Update step indicators
  document.querySelectorAll('.wizard-step').forEach(el => {
    const s = Number(el.dataset.step);
    el.classList.remove('active', 'completed');
    if (s === step) el.classList.add('active');
    else if (s < step) el.classList.add('completed');
  });

  // Update completed step numbers to checkmarks
  document.querySelectorAll('.wizard-step.completed .wizard-step-num').forEach(el => { el.textContent = '\u2713'; });
  document.querySelectorAll('.wizard-step:not(.completed) .wizard-step-num').forEach(el => {
    el.textContent = el.closest('.wizard-step').dataset.step;
  });

  // Footer buttons
  const backBtn = document.getElementById('wizardBack');
  const nextBtn = document.getElementById('wizardNext');
  const footer = document.getElementById('wizardFooter');
  backBtn.style.visibility = step === 1 ? 'hidden' : 'visible';

  if (step === 4) {
    nextBtn.textContent = 'Launch Site';
    nextBtn.className = 'btn btn-primary';
    updateLaunchSummary();
  } else {
    nextBtn.textContent = 'Next';
    nextBtn.className = 'btn btn-primary';
  }

  // Hide footer on success
  if (document.getElementById('launchDone').style.display !== 'none') {
    footer.style.display = 'none';
  }

  // Render step content
  if (step === 3) renderSources();

  // Save progress
  localStorage.setItem('wizard_step', step);
}

function validateStep(step) {
  if (step === 1 && !selectedNiche) {
    showAlert('Please select a niche to continue', 'error');
    return false;
  }
  if (step === 2) {
    const name = document.getElementById('wSiteName').value.trim();
    if (!name) { showAlert('Please enter a site name', 'error'); return false; }
  }
  if (step === 3) {
    const checked = wizardSources.filter(s => s.checked);
    if (!checked.length) { showAlert('Please select at least one source', 'error'); return false; }
  }
  return true;
}

// ── Step 1: Niche selection ──────────────────────────────────
function renderNiches() {
  const grid = document.getElementById('nicheGrid');
  grid.innerHTML = NICHE_TEMPLATES.map(t => `
    <div class="niche-card${selectedNiche === t.id ? ' selected' : ''}" data-niche="${t.id}">
      <div class="niche-card-icon">${t.icon}</div>
      <div class="niche-card-name">${escHtml(t.name)}</div>
      <div class="niche-card-desc">${escHtml(t.description)}</div>
      <div class="niche-card-count">${t.sources.length} sources included</div>
    </div>
  `).join('');

  grid.querySelectorAll('.niche-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedNiche = card.dataset.niche;
      grid.querySelectorAll('.niche-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      applyNicheDefaults(selectedNiche);
    });
  });
}

function applyNicheDefaults(nicheId) {
  const t = NICHE_TEMPLATES.find(n => n.id === nicheId);
  if (!t) return;
  document.getElementById('wSiteName').value = t.name + ' News';
  document.getElementById('wTagline').value = t.tagline;
  document.getElementById('wDescription').value = t.description ? ('Curated ' + t.description.toLowerCase() + ', powered by AI.') : '';
  document.getElementById('wEmoji').value = t.icon;
  document.getElementById('wAiPersona').value = t.persona || '';

  // Select matching theme
  const themeMatch = THEME_PRESETS.find(p => p.name === t.theme);
  if (themeMatch) {
    selectedTheme = themeMatch;
    renderThemes();
  }

  // Set up sources
  wizardSources = t.sources.map(s => ({ name: s.name, url: s.url, checked: true, status: 'pending' }));
}

// ── Step 2: Theme selection ──────────────────────────────────
function renderThemes() {
  const grid = document.getElementById('themeGrid');
  grid.innerHTML = THEME_PRESETS.map(t => `
    <div class="theme-swatch${selectedTheme && selectedTheme.name === t.name ? ' selected' : ''}" data-theme="${escHtml(t.name)}">
      <span class="theme-swatch-dot" style="background:${t.accent};"></span>
      ${escHtml(t.name)}
    </div>
  `).join('');

  grid.querySelectorAll('.theme-swatch').forEach(el => {
    el.addEventListener('click', () => {
      selectedTheme = THEME_PRESETS.find(p => p.name === el.dataset.theme);
      grid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
}

// ── Step 3: Sources ──────────────────────────────────────────
function renderSources() {
  const list = document.getElementById('sourceList');
  list.innerHTML = wizardSources.map((s, i) => `
    <div class="source-check">
      <input type="checkbox" ${s.checked ? 'checked' : ''} data-idx="${i}" />
      <div class="source-check-info">
        <div class="source-check-name">${escHtml(s.name)}</div>
        <div class="source-check-url">${escHtml(s.url)}</div>
      </div>
      <span class="source-check-status" id="srcStatus${i}">${statusBadge(s.status)}</span>
    </div>
  `).join('');

  // Checkbox listeners
  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      wizardSources[Number(cb.dataset.idx)].checked = cb.checked;
    });
  });

  // Validate feeds in parallel
  wizardSources.forEach((s, i) => {
    if (s.status !== 'pending') return;
    apiFetch('/sources/preview-feed', { method: 'POST', body: JSON.stringify({ url: s.url }) })
      .then(data => {
        s.status = 'valid';
        s.itemCount = data.itemCount;
        if (data.title && !s.nameOverridden) s.name = data.title;
        const el = document.getElementById('srcStatus' + i);
        if (el) el.innerHTML = statusBadge('valid', data.itemCount);
        // Update name display
        const nameEl = list.querySelectorAll('.source-check-name')[i];
        if (nameEl && data.title) nameEl.textContent = data.title;
      })
      .catch((err) => {
        s.status = 'error';
        s.errorDetail = err.message || 'Unknown error';
        const el = document.getElementById('srcStatus' + i);
        if (el) el.innerHTML = statusBadge('error', null, s.errorDetail);
      });
  });
}

function statusBadge(status, count, errorDetail) {
  if (status === 'pending') return '<span class="badge badge-muted">Checking...</span>';
  if (status === 'valid') return '<span class="badge badge-success">\u2713 ' + (count || '') + ' articles</span>';
  if (status === 'error') {
    const tip = errorDetail ? ' title="' + escHtml(errorDetail) + '"' : '';
    return '<span class="badge badge-danger"' + tip + '>Unavailable</span>';
  }
  return '';
}

// ── Step 4: Launch ───────────────────────────────────────────
function updateLaunchSummary() {
  const sources = wizardSources.filter(s => s.checked);
  const niche = NICHE_TEMPLATES.find(n => n.id === selectedNiche);
  const autoPublish = document.getElementById('wAutoPublish').checked;
  const writerCount = niche ? niche.categories.filter(c => c.writer).length : 0;
  document.getElementById('launchSourceCount').textContent = sources.length;
  document.getElementById('launchCatCount').textContent = niche ? niche.categories.length : 0;
  document.getElementById('launchWriterCount').textContent = writerCount;
  document.getElementById('launchThemeName').textContent = selectedTheme ? selectedTheme.name : 'Default';
  // Update launch button label
  const nextBtn = document.getElementById('wizardNext');
  if (nextBtn.textContent !== 'Launching...') {
    nextBtn.textContent = autoPublish ? 'Launch Site' : 'Launch Site (Drafts)';
  }
}

function setLaunchStep(key, state) {
  const el = document.querySelector('.launch-step[data-launch="' + key + '"]');
  if (!el) return;
  el.classList.remove('active', 'done');
  el.classList.add(state);
  const icon = el.querySelector('.launch-step-icon');
  if (state === 'active') icon.textContent = '\u23F3';
  else if (state === 'done') icon.textContent = '\u2705';
}

async function executeLaunch() {
  const niche = NICHE_TEMPLATES.find(n => n.id === selectedNiche);
  const sources = wizardSources.filter(s => s.checked);
  const siteName = document.getElementById('wSiteName').value.trim();
  const tagline = document.getElementById('wTagline').value.trim();
  const description = document.getElementById('wDescription').value.trim();
  const emoji = document.getElementById('wEmoji').value.trim();
  const aiPersona = document.getElementById('wAiPersona').value.trim();
  const geminiKey = document.getElementById('wGeminiKey').value.trim();
  const autoPublish = document.getElementById('wAutoPublish').checked;

  const nextBtn = document.getElementById('wizardNext');
  nextBtn.disabled = true;
  nextBtn.textContent = 'Launching...';
  document.getElementById('launchProgress').style.display = 'block';

  try {
    // 1. Save branding + settings
    setLaunchStep('branding', 'active');
    const brandPayload = { site_name: siteName, site_tagline: tagline };
    if (description) brandPayload.site_description = description;
    if (emoji) brandPayload.site_logo_emoji = emoji;
    if (aiPersona) brandPayload.site_ai_persona = aiPersona;
    if (geminiKey) brandPayload.gemini_api_key = geminiKey;
    if (selectedTheme) {
      brandPayload.site_accent_color = selectedTheme.accent;
      brandPayload.site_bg_color = selectedTheme.bg;
      brandPayload.site_bg_card_color = selectedTheme.bgCard;
      brandPayload.site_border_color = selectedTheme.border;
      brandPayload.site_text_color = selectedTheme.text;
      brandPayload.site_muted_color = selectedTheme.muted;
      brandPayload.site_accent_dim_color = selectedTheme.accentDim;
    }
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(brandPayload) });
    setLaunchStep('branding', 'done');

    // 2. Save categories — capture response with IDs
    setLaunchStep('categories', 'active');
    let savedCategories = [];
    if (niche && niche.categories.length) {
      savedCategories = await apiFetch('/categories', { method: 'PUT', body: JSON.stringify(niche.categories.map(c => ({ name: c.name, color: c.color, keywords: [] }))) });
      if (!Array.isArray(savedCategories)) savedCategories = [];
    }
    setLaunchStep('categories', 'done');

    // 3. Generate keywords for each category
    setLaunchStep('keywords', 'active');
    if (niche) {
      for (const cat of niche.categories) {
        try {
          await apiFetch('/categories/generate-keywords', {
            method: 'POST',
            body: JSON.stringify({ name: cat.name, existingKeywords: [] }),
          });
        } catch { /* continue on failure */ }
      }
    }
    setLaunchStep('keywords', 'done');

    // 4. Create sources
    setLaunchStep('sources', 'active');
    for (const src of sources) {
      try {
        await apiFetch('/sources', {
          method: 'POST',
          body: JSON.stringify({ name: src.name, url: src.url, priority: 1, is_active: true, auto_publish: autoPublish }),
        });
      } catch { /* continue — may already exist */ }
    }
    setLaunchStep('sources', 'done');

    // 5. Create one writer per category (upsert — update beats if writer already exists)
    setLaunchStep('writer', 'active');
    if (niche) {
      // Use saved categories from step 2 to get IDs for beat assignment
      const catIdByName = {};
      for (const c of savedCategories) catIdByName[c.name.toLowerCase()] = c.id;

      // Fetch existing writers so we can update instead of failing on duplicate slugs
      const existingWriters = await apiFetch('/admin/writers').catch(() => []);
      const writerBySlug = {};
      for (const w of existingWriters) writerBySlug[w.slug] = w;

      for (const cat of niche.categories) {
        if (!cat.writer) continue;
        const catId = catIdByName[cat.name.toLowerCase()];
        const slug = cat.writer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const payload = {
          name: cat.writer,
          bio: cat.writer + ' covers ' + cat.name + ' news and analysis.',
          beat: cat.name,
          beats: catId ? [catId] : [],
          keywords: [],
          system_prompt: aiPersona || niche.persona || '',
          is_auto: true,
          synthesis_schedule: 'daily',
          synthesis_lookback_hours: 168,
          min_cluster_size: 3,
        };
        try {
          const existing = writerBySlug[slug];
          if (existing) {
            await apiFetch('/admin/writers/' + existing.id, {
              method: 'PUT',
              body: JSON.stringify(payload),
            });
          } else {
            await apiFetch('/admin/writers', {
              method: 'POST',
              body: JSON.stringify(payload),
            });
          }
        } catch { /* continue on error */ }
      }
    }
    setLaunchStep('writer', 'done');

    // 6. Fetch articles
    setLaunchStep('fetch', 'active');
    await apiFetch('/fetch', { method: 'POST', body: JSON.stringify({}) });
    setLaunchStep('fetch', 'done');

    // 6. Mark wizard as completed
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify({ wizard_completed: '1', wizard_niche: selectedNiche }) });

    // Show success
    document.getElementById('launchReady').style.display = 'none';
    document.getElementById('launchDone').style.display = 'block';
    document.getElementById('wizardFooter').style.display = 'none';
    localStorage.removeItem('wizard_step');

  } catch (err) {
    showAlert('Launch failed: ' + err.message, 'error');
    nextBtn.disabled = false;
    nextBtn.textContent = 'Retry Launch';
  }
}

// ── Custom source ────────────────────────────────────────────
function initCustomSource() {
  document.getElementById('addCustomSourceBtn').addEventListener('click', () => {
    const row = document.getElementById('customSourceRow');
    row.style.display = row.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('wCustomFetchBtn').addEventListener('click', async () => {
    const url = document.getElementById('wCustomUrl').value.trim();
    const status = document.getElementById('wCustomStatus');
    if (!url) return;

    status.innerHTML = '<span style="color:var(--muted);">Checking feed...</span>';
    try {
      const data = await apiFetch('/sources/preview-feed', { method: 'POST', body: JSON.stringify({ url }) });
      const name = data.title || url.replace(/https?:\/\//, '').split('/')[0];
      wizardSources.push({ name, url, checked: true, status: 'valid', itemCount: data.itemCount });
      status.innerHTML = '<span style="color:var(--success);">\u2713 Added: ' + escHtml(name) + ' (' + data.itemCount + ' articles)</span>';
      document.getElementById('wCustomUrl').value = '';
      renderSources();
    } catch (err) {
      status.innerHTML = '<span style="color:var(--danger);">\u2717 ' + escHtml(err.message || 'Not a valid RSS feed') + '</span>';
    }
  });
}

// ── Existing data detection & reset ──────────────────────────
async function checkExistingData() {
  try {
    const [articles, sources, categories, writers] = await Promise.all([
      apiFetch('/articles').catch(() => []),
      apiFetch('/sources').catch(() => []),
      apiFetch('/categories').catch(() => []),
      apiFetch('/admin/writers').catch(() => []),
    ]);
    const total = articles.length + sources.length + categories.length + writers.length;
    if (total > 0) {
      const parts = [];
      if (articles.length) parts.push(articles.length + ' article' + (articles.length !== 1 ? 's' : ''));
      if (sources.length) parts.push(sources.length + ' source' + (sources.length !== 1 ? 's' : ''));
      if (categories.length) parts.push(categories.length + ' categor' + (categories.length !== 1 ? 'ies' : 'y'));
      if (writers.length) parts.push(writers.length + ' writer' + (writers.length !== 1 ? 's' : ''));
      document.getElementById('existingCount').textContent = parts.join(', ');
      document.getElementById('existingDataBanner').style.display = 'block';
    }
  } catch { /* ignore */ }
}

async function resetAllData() {
  const btn = document.getElementById('wizardResetBtn');
  const status = document.getElementById('resetStatus');
  if (!confirm('This will permanently delete ALL articles, sources, and categories. Continue?')) return;
  btn.disabled = true;
  status.textContent = 'Clearing data...';
  try {
    // Delete all articles
    const articles = await apiFetch('/articles').catch(() => []);
    for (const a of articles) {
      try { await apiFetch('/articles/' + a.id, { method: 'DELETE' }); } catch {}
    }
    // Delete all sources
    const sources = await apiFetch('/sources').catch(() => []);
    for (const s of sources) {
      try { await apiFetch('/sources/' + s.id, { method: 'DELETE' }); } catch {}
    }
    // Delete all writers
    const writers = await apiFetch('/admin/writers').catch(() => []);
    for (const w of writers) {
      try { await apiFetch('/admin/writers/' + w.id, { method: 'DELETE' }); } catch {}
    }
    // Clear categories by saving empty array
    await apiFetch('/categories', { method: 'PUT', body: JSON.stringify([{ name: 'General', color: '#94a3b8', keywords: [] }]) }).catch(() => {});
    // Clear wizard_completed
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify({ wizard_completed: '' }) }).catch(() => {});

    status.innerHTML = '<span style="color:var(--success);">\u2713 All data cleared. Pick your niche below.</span>';
    document.getElementById('wizardResetBtn').style.display = 'none';
    document.getElementById('wizardAppendBtn').style.display = 'none';
    showAlert('Site data cleared');
  } catch (err) {
    status.innerHTML = '<span style="color:var(--danger);">Reset failed: ' + escHtml(err.message) + '</span>';
    btn.disabled = false;
  }
}

// ── Init ─────────────────────────────────────────────────────
onReady(() => {
  if (!requireAuth()) return;
  renderSidebar();

  renderNiches();
  renderThemes();
  initCustomSource();
  checkExistingData();

  // API key show/hide toggle
  document.getElementById('wToggleKeyBtn').addEventListener('click', function () {
    const input = document.getElementById('wGeminiKey');
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    this.textContent = isPassword ? 'Hide' : 'Show';
  });

  document.getElementById('wizardResetBtn').addEventListener('click', resetAllData);
  document.getElementById('wizardAppendBtn').addEventListener('click', () => {
    document.getElementById('existingDataBanner').style.display = 'none';
  });

  // Restore progress
  const savedStep = parseInt(localStorage.getItem('wizard_step'));
  if (savedStep > 1 && savedStep <= 4) goToStep(savedStep);

  // Navigation
  document.getElementById('wizardNext').addEventListener('click', () => {
    if (currentStep === 4) {
      executeLaunch();
    } else {
      if (validateStep(currentStep)) goToStep(currentStep + 1);
    }
  });

  document.getElementById('wizardBack').addEventListener('click', () => {
    if (currentStep > 1) goToStep(currentStep - 1);
  });
});
