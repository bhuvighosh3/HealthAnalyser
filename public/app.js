let currentAthleteId = null;

function handleLogout() {
    sessionStorage.removeItem('athleteiq_mode');
    window.location.href = '/login.html';
}

// Returns the profile key ('bhuvi', 'rishit', 'ritwik', or '') from the stored login mode.
// Sent as X-Profile header so the server uses the right Strava credentials
// regardless of which Cloud Run instance handles the request.
function getProfileKey() {
    const mode = sessionStorage.getItem('athleteiq_mode') || '';
    if (mode === 'sample_bhuvi')  return 'bhuvi';
    if (mode === 'sample_rishit') return 'rishit';
    if (mode === 'sample_ritwik') return 'ritwik';
    return ''; // 'own' credentials — server uses tokens from /api/auth/configure
}

function apiHeaders(extra = {}) {
    const profile = getProfileKey();
    const h = { 'Content-Type': 'application/json', ...extra };
    if (profile) h['X-Profile'] = profile;
    return h;
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Fetch athlete profile
        const profileRes = await fetch('/api/athlete', { headers: apiHeaders() });
        if (!profileRes.ok) throw new Error('Failed to fetch profile');
        const athlete = await profileRes.json();

        currentAthleteId = athlete.id;
        renderProfile(athlete);

        // Fetch athlete stats
        const statsRes = await fetch(`/api/athlete/stats/${athlete.id}`, { headers: apiHeaders() });
        if (!statsRes.ok) throw new Error('Failed to fetch stats');
        const stats = await statsRes.json();

        renderStats(stats);
    } catch (err) {
        console.error(err);
        alert('Could not load data. Ensure the backend proxy is running and your tokens are valid.');
    }
});

function renderProfile(athlete) {
    // Header mini-profile
    const container = document.getElementById('profileContainer');
    const locationStr = [athlete.city, athlete.country].filter(Boolean).join(', ');
    container.innerHTML = `
        <img src="${athlete.profile_medium || ''}" alt="Profile" class="avatar">
        <div class="profile-info">
            <span class="user-name">${athlete.firstname} ${athlete.lastname}</span>
            <span class="location">${locationStr || 'Strava Athlete'}</span>
        </div>
    `;

    // Large profile card
    const card = document.getElementById('athleteProfileCard');
    document.getElementById('athleteAvatar').src = athlete.profile || athlete.profile_medium || '';
    document.getElementById('athleteFullName').innerText = `${athlete.firstname} ${athlete.lastname}`;
    document.getElementById('athleteFullName').classList.remove('skeleton-text');

    const loc = [athlete.city, athlete.state, athlete.country].filter(Boolean).join(', ');
    document.getElementById('athleteLocation').innerText = loc || '';

    const bio = typeof athlete.bio === 'string' ? athlete.bio.trim() : '';
    const bioEl = document.getElementById('athleteBio');
    bioEl.innerText = bio || '';
    bioEl.style.display = bio ? 'block' : 'none';

    const badges = [];
    if (athlete.premium || athlete.summit) badges.push('<span class="profile-badge summit">Summit</span>');
    if (athlete.sex)    badges.push(`<span class="profile-badge">${athlete.sex === 'M' ? 'Male' : athlete.sex === 'F' ? 'Female' : athlete.sex}</span>`);
    if (athlete.username) badges.push(`<span class="profile-badge">@${athlete.username}</span>`);
    document.getElementById('athleteBadges').innerHTML = badges.join('');

    card.classList.remove('hidden');
}

function renderStats(stats) {
    const fmtKm   = (m)  => (m / 1000).toFixed(1) + ' km';
    const fmtHrs  = (s)  => (s / 3600).toFixed(1) + ' hrs';
    const fmtElev = (m)  => Math.round(m) + ' m';
    const set     = (id, val) => {
        const el = document.getElementById(id);
        if (el) { el.innerText = val ?? '—'; el.classList.remove('skeleton-text'); }
    };
    const setCard = (id, val) => {
        const el = document.querySelector(`${id} .stat-value`);
        if (el) { el.innerText = val ?? '—'; el.classList.remove('skeleton-text'); }
    };

    // ── All-Time Runs ─────────────────────────────────────────────────────────
    const allR = stats.all_run_totals || {};
    setCard('#stat-activities',  allR.count     ?? '—');
    setCard('#stat-distance',    allR.distance  ? (allR.distance/1000).toFixed(0) : '—');
    setCard('#stat-time',        allR.moving_time ? (allR.moving_time/3600).toFixed(0) : '—');
    setCard('#stat-elevation',   allR.elevation_gain ? Math.round(allR.elevation_gain).toLocaleString() : '—');

    // ── PRs & Achievements ────────────────────────────────────────────────────
    const c = stats.computed || {};
    setCard('#stat-prs',          c.totalPRs          ?? '—');
    setCard('#stat-achievements', c.totalAchievements ?? '—');

    // ── Personal Bests ────────────────────────────────────────────────────────
    setCard('#stat-bestpace',   c.bestPace    ?? '—');
    setCard('#stat-longestrun', c.longestRun  ? c.longestRun.distKm : '—');
    setCard('#stat-avghr',      c.avgHR       ? c.avgHR + ' bpm' : '—');
    setCard('#stat-maxhr',      c.maxHR       ? c.maxHR + ' bpm' : '—');
    setCard('#stat-consistency', c.consistencyScore != null ? c.consistencyScore + '%' : '—');
    setCard('#stat-intensity',   c.avgSufferScore    ?? '—');

    // Sub-labels for best pace and longest run
    if (c.bestPaceActivity) {
        const sub = document.getElementById('stat-bestpace-sub');
        if (sub) sub.innerText = `"${c.bestPaceActivity.name}" · ${c.bestPaceActivity.distKm} km`;
    }
    if (c.longestRun) {
        const sub = document.getElementById('stat-longestrun-sub');
        if (sub) sub.innerText = `"${c.longestRun.name}" · ${c.longestRun.date}`;
    }

    // ── YTD Runs ──────────────────────────────────────────────────────────────
    const ytd = stats.ytd_run_totals || {};
    set('ytd-count', ytd.count ?? '—');
    set('ytd-dist',  ytd.distance  ? fmtKm(ytd.distance)  : '—');
    set('ytd-time',  ytd.moving_time ? fmtHrs(ytd.moving_time) : '—');
    set('ytd-elev',  ytd.elevation_gain != null ? fmtElev(ytd.elevation_gain) : '—');

    // ── Recent 4-week Runs ────────────────────────────────────────────────────
    const rec = stats.recent_run_totals || {};
    set('recent-count',  rec.count ?? '—');
    set('recent-dist',   rec.distance   ? fmtKm(rec.distance)   : '—');
    set('recent-time',   rec.moving_time ? fmtHrs(rec.moving_time) : '—');
    set('recent-weekly', c.avgWeeklyKm  != null ? c.avgWeeklyKm + ' km' : '—');
    set('recent-elev',   c.recentElevation != null ? fmtElev(c.recentElevation) : '—');

    // ── YTD Cycling ───────────────────────────────────────────────────────────
    const rides = stats.ytd_ride_totals || {};
    set('ytd-rides-count', rides.count     ?? '0');
    set('ytd-rides-dist',  rides.distance  ? fmtKm(rides.distance)      : '0 km');
    set('ytd-rides-time',  rides.moving_time ? fmtHrs(rides.moving_time) : '0 hrs');

    // ── Sport breakdown in profile card ───────────────────────────────────────
    if (c.sportBreakdown) {
        const container = document.getElementById('athleteSportBreakdown');
        if (container) {
            const icons = { Run:'footprints', Ride:'bike', Walk:'person-standing', Hike:'mountain', Swim:'waves', VirtualRun:'monitor' };
            container.innerHTML = Object.entries(c.sportBreakdown)
                .sort((a,b) => b[1]-a[1])
                .map(([type, count]) => `
                    <div class="sport-item">
                        <i data-lucide="${icons[type] || 'activity'}" class="sport-icon"></i>
                        <span class="sport-count">${count}</span>
                        <span class="sport-label">${type}</span>
                    </div>`).join('');
            lucide.createIcons();
        }
    }
}

function removeSkeleton(selector) {
    const el = document.querySelector(selector);
    if (el.classList.contains('skeleton-text')) {
        el.classList.remove('skeleton-text');
    }
    const valObj = el.querySelector('.stat-value');
    if (valObj && valObj.classList.contains('skeleton-text')) {
        valObj.classList.remove('skeleton-text');
    }
}

// --- Chat Logic ---
const chatToggle   = document.getElementById('chatToggle');
const chatBox      = document.getElementById('chatBox');
const chatClose    = document.getElementById('chatClose');
const chatInput    = document.getElementById('chatInput');
const chatSend     = document.getElementById('chatSend');
const chatMessages = document.getElementById('chatMessages');
const chatGreeting = document.getElementById('chatGreeting');

function dismissGreeting() { chatGreeting?.classList.add('hidden'); }

document.getElementById('chatGreetingClose')?.addEventListener('click', dismissGreeting);
chatToggle.addEventListener('click', () => { chatBox.classList.remove('hidden'); dismissGreeting(); });
chatClose.addEventListener('click', () => chatBox.classList.add('hidden'));

chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

async function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || !currentAthleteId) return;

    // Add User Message
    addMessage(text, 'user');
    chatInput.value = '';

    // Add Loading Indicator
    const loaderId = addMessage('...', 'ai');

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({ message: text, id: currentAthleteId })
        });
        const data = await response.json();

        const loaderEl = document.getElementById(loaderId);
        if (loaderEl) loaderEl.innerHTML = markdownToHtml(data.reply || data.error);

    } catch (err) {
        const loaderEl = document.getElementById(loaderId);
        if (loaderEl) loaderEl.innerHTML = markdownToHtml("Error trying to reach the assistant.");
    }
}

function addMessage(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    // User messages are plain text; AI messages render markdown
    if (sender === 'ai') {
        msgDiv.innerHTML = markdownToHtml(text);
    } else {
        msgDiv.innerText = text;
    }

    const msgId = 'msg-' + Date.now();
    msgDiv.id = msgId;

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    lucide.createIcons();
    return msgId;
}

// ===== ANALYSIS LOGIC =====
const analyseBtn     = document.getElementById('analyseBtn');
const chartsBtn      = document.getElementById('chartsBtn');
const analysisLoader = document.getElementById('analysisLoader');
const analysisLoaderText = document.getElementById('analysisLoaderText');
const analysisResults = document.getElementById('analysisResults');
const analysisError  = document.getElementById('analysisError');
const forecastResultsMain = document.getElementById('forecastResultsMain');

let chartInstances = [];

// Persist body stats in localStorage
const FORECAST_STORAGE_KEY = 'healthAnalyserForecastStats';
function loadSavedStats() {
    try {
        const s = JSON.parse(localStorage.getItem(FORECAST_STORAGE_KEY) || '{}');
        if (s.age)      document.getElementById('f-age').value      = s.age;
        if (s.sex)      document.getElementById('f-sex').value      = s.sex;
        if (s.weight)   document.getElementById('f-weight').value   = s.weight;
        if (s.height)   document.getElementById('f-height').value   = s.height;
        if (s.goal)     document.getElementById('goalSelect').value = s.goal;
        if (s.target)   document.getElementById('f-target').value   = s.target;
        if (s.duration) document.getElementById('f-duration').value = s.duration;
    } catch (_) {}
}
loadSavedStats();

analyseBtn.addEventListener('click', runAnalysis);
chartsBtn.addEventListener('click', runChartsOnly);

// ── Analyse My Goal: Charts + Hypothesis + Recommendations ───────────────────
async function runAnalysis() {
    analyseBtn.disabled = true;
    chartsBtn.disabled  = true;
    const ogHtml = analyseBtn.innerHTML;
    analyseBtn.innerHTML = '<i data-lucide="loader-2" class="analyse-btn-icon spin-icon"></i> Analysing...';

    analysisLoader.classList.remove('hidden');
    analysisLoaderText.textContent = 'Loading your charts...';
    analysisError.classList.add('hidden');
    analysisResults.classList.add('hidden');
    forecastResultsMain.classList.add('hidden');

    chartInstances.forEach(c => c.destroy());
    chartInstances = [];

    // Collect all form values
    const age          = parseInt(document.getElementById('f-age').value)      || 25;
    const sex          = document.getElementById('f-sex').value;
    const weight       = parseFloat(document.getElementById('f-weight').value) || 70;
    const height       = parseFloat(document.getElementById('f-height').value) || 170;
    const goal         = document.getElementById('goalSelect').value;
    const focus        = document.getElementById('focusSelect').value;
    const target       = document.getElementById('f-target').value.trim();
    const durationWeeks = parseInt(document.getElementById('f-duration').value) || 12;
    const context      = document.getElementById('contextInput').value.trim();

    // Save body stats for next visit
    localStorage.setItem(FORECAST_STORAGE_KEY, JSON.stringify({ age, sex, weight, height, goal, target, duration: durationWeeks }));

    try {
        // Fire both requests in parallel
        const statsPromise    = fetch('/api/stats', { headers: apiHeaders() }).then(r => r.json());
        const forecastPromise = fetch('/api/forecast', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({ age, sex, weight, height, goal, focus, target, durationWeeks, context })
        }).then(r => r.json());

        // Render charts as soon as they arrive
        const statsData = await statsPromise;
        if (statsData.error) throw new Error(statsData.error);
        analysisResults.classList.remove('hidden');
        renderCharts(statsData.charts);

        analysisLoaderText.textContent = 'Running hypothesis check & building your plan...';

        // Then render forecast
        const forecastData = await forecastPromise;
        if (forecastData.error) throw new Error(forecastData.error);

        analysisLoader.classList.add('hidden');
        renderForecastResults(forecastData);
        forecastResultsMain.classList.remove('hidden');

        analysisResults.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
        console.error('Analysis error:', err);
        analysisLoader.classList.add('hidden');
        analysisError.classList.remove('hidden');
        analysisError.querySelector('p').innerText = 'Failed to analyse: ' + err.message;
    } finally {
        analyseBtn.disabled = false;
        chartsBtn.disabled  = false;
        analyseBtn.innerHTML = ogHtml;
        lucide.createIcons();
    }
}

// ── Instant Smart Charts only ───────────────────────────────────────────��─────
async function runChartsOnly() {
    chartsBtn.disabled  = true;
    analyseBtn.disabled = true;
    const ogHtml = chartsBtn.innerHTML;
    chartsBtn.innerHTML = '<i data-lucide="loader-2" class="analyse-btn-icon spin-icon"></i> Loading...';

    analysisLoader.classList.remove('hidden');
    analysisLoaderText.textContent = 'Loading your charts...';
    analysisError.classList.add('hidden');
    analysisResults.classList.add('hidden');
    forecastResultsMain.classList.add('hidden');

    chartInstances.forEach(c => c.destroy());
    chartInstances = [];

    try {
        const statsData = await fetch('/api/stats', { headers: apiHeaders() }).then(r => r.json());
        if (statsData.error) throw new Error(statsData.error);

        analysisLoader.classList.add('hidden');
        analysisResults.classList.remove('hidden');
        renderCharts(statsData.charts);
        analysisResults.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
        console.error('Charts error:', err);
        analysisLoader.classList.add('hidden');
        analysisError.classList.remove('hidden');
        analysisError.querySelector('p').innerText = 'Failed to load charts: ' + err.message;
    } finally {
        chartsBtn.disabled  = false;
        analyseBtn.disabled = false;
        chartsBtn.innerHTML = ogHtml;
        lucide.createIcons();
    }
}

function renderCharts(charts) {
    if (!charts) { console.error('renderCharts: no chart data'); return; }

    // Chart.js defaults for the black/blue theme
    Chart.defaults.color       = '#7ec8e3';
    Chart.defaults.borderColor = 'rgba(56, 189, 248, 0.1)';

    const BLUE  = '#38bdf8';
    const BLUE2 = '#0ea5e9';
    const CYAN  = '#22d3ee';
    const TEAL  = '#2dd4bf';
    const PURP  = '#818cf8';
    const PINK  = '#f472b6';

    const blueGrad = (ctx) => {
        const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
        g.addColorStop(0, 'rgba(56,189,248,0.45)');
        g.addColorStop(1, 'rgba(56,189,248,0.02)');
        return g;
    };

    const scaleDefaults = {
        x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: 'rgba(56,189,248,0.08)' } },
    };

    const charts_map = [
        {
            key: 'distanceTrend', id: 'distanceChart', type: 'line',
            dataset: d => ({
                label: 'Distance (km)', data: d.data,
                borderColor: BLUE, backgroundColor: blueGrad,
                fill: true, tension: 0.35, pointRadius: 4,
                pointBackgroundColor: BLUE, pointBorderColor: '#050a12', pointBorderWidth: 2,
            }),
            options: { scales: scaleDefaults },
        },
        {
            key: 'paceTrend', id: 'paceChart', type: 'line',
            dataset: d => ({
                label: 'Pace (min/km)', data: d.data,
                borderColor: CYAN,
                backgroundColor: (ctx) => {
                    const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
                    g.addColorStop(0, 'rgba(34,211,238,0.35)');
                    g.addColorStop(1, 'rgba(34,211,238,0.02)');
                    return g;
                },
                fill: true, tension: 0.35, pointRadius: 4,
                pointBackgroundColor: CYAN, pointBorderColor: '#050a12', pointBorderWidth: 2,
            }),
            options: { scales: { ...scaleDefaults, y: { ...scaleDefaults.y, reverse: true, title: { display: true, text: 'min/km', color: '#7ec8e3' } } } },
        },
        {
            key: 'weeklyVolume', id: 'weeklyChart', type: 'bar',
            dataset: d => ({
                label: 'Weekly km', data: d.data,
                backgroundColor: 'rgba(56,189,248,0.55)',
                borderColor: BLUE, borderWidth: 1, borderRadius: 8,
                hoverBackgroundColor: BLUE,
            }),
            options: { scales: { ...scaleDefaults, y: { ...scaleDefaults.y, title: { display: true, text: 'km', color: '#7ec8e3' } } } },
        },
        {
            key: 'activityTypes', id: 'typesChart', type: 'doughnut',
            dataset: d => ({
                data: d.data,
                backgroundColor: [BLUE, CYAN, TEAL, PURP, PINK, BLUE2].slice(0, d.data.length),
                borderColor: '#050a12', borderWidth: 3, hoverOffset: 8,
            }),
            options: { cutout: '60%', plugins: { legend: { position: 'bottom', labels: { padding: 16, font: { size: 12 }, color: '#7ec8e3' } } } },
        },
        {
            key: 'hrDistribution', id: 'hrChart', type: 'bar',
            dataset: d => ({
                label: 'Activities', data: d.data,
                backgroundColor: [
                    'rgba(56,189,248,0.7)', 'rgba(34,211,238,0.7)',
                    'rgba(45,212,191,0.7)', 'rgba(129,140,248,0.7)', 'rgba(244,114,182,0.7)'
                ],
                borderRadius: 6,
            }),
            options: { scales: scaleDefaults },
        },
        {
            key: 'efficiencyTrend', id: 'efficiencyChart', type: 'line',
            dataset: d => ({
                label: 'Efficiency', data: d.data,
                borderColor: PURP,
                backgroundColor: 'rgba(129,140,248,0.2)',
                fill: true, tension: 0.4, pointRadius: 4,
                pointBackgroundColor: PURP, pointBorderColor: '#050a12', pointBorderWidth: 2,
            }),
            options: { scales: scaleDefaults },
        },
    ];

    charts_map.forEach(({ key, id, type, dataset, options }) => {
        const raw = charts[key];
        if (!raw) return;
        try {
            const canvas = document.getElementById(id);
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            chartInstances.push(new Chart(ctx, {
                type,
                data: { labels: raw.labels, datasets: [dataset(raw)] },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: { legend: { display: false } },
                    ...options,
                },
            }));
        } catch (err) {
            console.error(`Chart "${id}" failed:`, err);
        }
    });

    // Force correct sizing after the container becomes visible
    requestAnimationFrame(() => chartInstances.forEach(c => c.resize()));
}


// ── Render Results ────────────────────────────────────────────────────────────
function renderForecastResults({ hypothesis, recommendations, edaSummary, weeklySummary }) {
    const forecastData = { hypothesis, recommendations, edaSummary, weeklySummary };

    // 0. EDA Summary — render markdown to HTML
    if (edaSummary) {
        document.getElementById('edaSummaryText').innerHTML = markdownToHtml(edaSummary);
        document.getElementById('edaSummaryCard').classList.remove('hidden');
    }


    // 1. Feasibility
    const label = hypothesis.feasibility || 'unknown';
    const score = hypothesis.feasibilityScore ?? 0;
    const badgeEl = document.getElementById('feasibilityLabel');
    badgeEl.textContent = label.charAt(0).toUpperCase() + label.slice(1);
    badgeEl.className = `feasibility-badge ${label}`;
    document.getElementById('feasibilityScore').textContent = `${score}/100`;
    document.getElementById('feasibilityBar').style.width = `${score}%`;
    document.getElementById('hypothesisSummary').textContent = hypothesis.summary || '';

    // 2. State comparison
    const cs = hypothesis.currentState || {};
    const rs = hypothesis.requiredState || {};
    document.getElementById('currentState').innerHTML = stateMetrics([
        ['Distance', `${cs.weeklyDistKm ?? '—'} km`],
        ['Calories',  `${cs.weeklyKcal ?? '—'} kcal`],
        ['Hours',     `${cs.weeklyHours ?? '—'} hrs`],
        ['VO2max',    cs.estimatedVO2Max ? `~${cs.estimatedVO2Max}` : '—'],
    ]);
    document.getElementById('requiredState').innerHTML = stateMetrics([
        ['Distance', `${rs.weeklyDistKm ?? '—'} km`],
        ['Calories',  `${rs.weeklyKcal ?? '—'} kcal`],
        ['Hours',     `${rs.weeklyHours ?? '—'} hrs`],
        ['Notes',     rs.notes ? truncate(rs.notes, 28) : '—'],
    ]);

    // 3. Projections
    const proj = hypothesis.projections || {};
    document.getElementById('projectionsCard').innerHTML = `
        <p class="sub-title">Projections</p>
        <div class="proj-grid">
            <div class="proj-item"><div class="p-label">Weeks to Goal</div><div class="p-val">${proj.weeksToGoal ?? '—'}</div></div>
            <div class="proj-item"><div class="p-label">Progress by Deadline</div><div class="p-val">${proj.estimatedProgressByDeadline ?? '—'}</div></div>
            <div class="proj-item"><div class="p-label">Total kcal Burned</div><div class="p-val">${proj.totalKcalBurnedByDeadline ? Number(proj.totalKcalBurnedByDeadline).toLocaleString() : '—'}</div></div>
            <div class="proj-item"><div class="p-label">Weight Change</div><div class="p-val">${proj.expectedWeightChangeKg !== null && proj.expectedWeightChangeKg !== undefined ? proj.expectedWeightChangeKg + ' kg' : '—'}</div></div>
        </div>`;

    // 4. Assumptions + Gaps
    const assumptions = hypothesis.assumptions || [];
    const gaps        = hypothesis.gaps || [];
    const risks       = hypothesis.riskFactors || [];
    document.getElementById('assumptionsCard').innerHTML = `
        <p class="sub-title">Assumptions</p>
        <ul class="bullet-list">${assumptions.map(a => `<li>${a}</li>`).join('')}</ul>
        ${gaps.length ? `<p class="sub-title" style="margin-top:.9rem">Gaps to Address</p><ul class="bullet-list">${gaps.map(g => `<li>${g}</li>`).join('')}</ul>` : ''}
        ${risks.length ? `<p class="sub-title" style="margin-top:.9rem">Risk Factors</p><ul class="bullet-list">${risks.map(r => `<li>${r}</li>`).join('')}</ul>` : ''}`;

    // 5. Coach note
    document.getElementById('coachNote').textContent = recommendations.coachNote || '';

    // 6. Weekly targets
    // Safety: AI occasionally returns comma-separated progressions — take the last (peak) value
    const parseTarget = v => {
        if (v == null) return null;
        const s = String(v);
        return s.includes(',') ? parseFloat(s.split(',').pop()) : parseFloat(s);
    };
    const rawWt = recommendations.weeklyTargets || {};
    const wt = {
        distanceKm:  parseTarget(rawWt.distanceKm),
        kcal:        parseTarget(rawWt.kcal),
        activeHours: parseTarget(rawWt.activeHours),
        longRunKm:   parseTarget(rawWt.longRunKm),
    };
    document.getElementById('weeklyTargets').innerHTML = `
        <p class="sub-title">Weekly Targets</p>
        <div class="targets-row">
            <div class="target-chip"><div class="t-val">${wt.distanceKm != null ? wt.distanceKm + ' km' : '—'}</div><div class="t-label">Distance</div></div>
            <div class="target-chip"><div class="t-val">${wt.kcal != null ? Math.round(wt.kcal).toLocaleString() + ' kcal' : '—'}</div><div class="t-label">Calories</div></div>
            <div class="target-chip"><div class="t-val">${wt.activeHours != null ? wt.activeHours + ' hrs' : '—'}</div><div class="t-label">Active Time</div></div>
            <div class="target-chip"><div class="t-val">${wt.longRunKm != null ? wt.longRunKm + ' km' : '—'}</div><div class="t-label">Long Run</div></div>
        </div>`;

    // 7. Training plan
    // Support both week-group format [{ week, days }] and legacy flat format [{ day, workout, ... }]
    const rawPlan = recommendations.weeklyTrainingPlan || [];
    const planWeeks = rawPlan.length && rawPlan[0].days
        ? rawPlan
        : [{ week: 1, days: rawPlan }];
    const flatPlan = planWeeks.flatMap(w => w.days || []);
    initCalendarSection(flatPlan);
    initDownloadButton(flatPlan, recommendations, hypothesis);
    initNutritionSection(forecastData.weeklySummary);
    renderTrainingPlanWeek(planWeeks, 0);

    // 8. Recovery
    const recovery = recommendations.recoveryAdvice || [];
    const recHtml = recovery.length
        ? recovery.map(r => `<div class="sub-item"><strong>${r.title}:</strong> ${r.detail}</div>`).join('')
        : '';
    document.getElementById('nutritionTips').innerHTML = recHtml
        ? `<p class="sub-title">Recovery</p>${recHtml}`
        : '';

    // 10. Milestones
    const milestones = recommendations.milestones || [];
    document.getElementById('milestonesCard').innerHTML = `
        <p class="sub-title">Milestones</p>
        ${milestones.map(m => `
            <div class="milestone">
                <span class="milestone-week">Week ${m.week}</span>
                <span class="milestone-target">${m.target}</span>
            </div>`).join('')}`;
}

function stateMetrics(pairs) {
    return pairs.map(([label, val]) =>
        `<div class="state-metric"><span class="s-label">${label}</span><span class="s-val">${val}</span></div>`
    ).join('');
}

function truncate(str, n) {
    return str.length > n ? str.slice(0, n) + '…' : str;
}

// ── Week-by-week training plan renderer ──────────────────────────────────────
function renderTrainingPlanWeek(planWeeks, idx) {
    const el = document.getElementById('trainingPlan');
    if (!el) return;
    const week = planWeeks[idx];
    const days = week?.days || [];
    const total = planWeeks.length;
    el.innerHTML = `
        <p class="sub-title">Weekly Training Plan</p>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;">
            <button onclick="renderTrainingPlanWeek(_currentPlanWeeks, Math.max(0, _currentPlanWeekIdx - 1))"
                style="background:var(--glass-bg);border:1px solid var(--glass-border);color:var(--text-primary);padding:.35rem .85rem;border-radius:8px;cursor:pointer;font-size:.85rem;opacity:${idx === 0 ? '.35' : '1'};pointer-events:${idx === 0 ? 'none' : 'auto'}">← Prev</button>
            <span style="font-weight:600;color:var(--accent)">Week ${week?.week ?? idx + 1} of ${total}</span>
            <button onclick="renderTrainingPlanWeek(_currentPlanWeeks, Math.min(_currentPlanWeeks.length - 1, _currentPlanWeekIdx + 1))"
                style="background:var(--glass-bg);border:1px solid var(--glass-border);color:var(--text-primary);padding:.35rem .85rem;border-radius:8px;cursor:pointer;font-size:.85rem;opacity:${idx === total - 1 ? '.35' : '1'};pointer-events:${idx === total - 1 ? 'none' : 'auto'}">Next →</button>
        </div>
        ${days.map(d => `
            <div class="plan-day">
                <span class="plan-day-name">${d.day}</span>
                <span class="plan-workout">${d.workout}
                    <small>${d.duration}${d.targetHR && d.targetHR !== 'N/A' ? ' · ' + d.targetHR : ''} · ${d.purpose}</small>
                </span>
                <span class="plan-intensity intensity-${(d.intensity||'moderate').toLowerCase()}">${d.intensity||''}</span>
            </div>`).join('')}`;
    _currentPlanWeeks = planWeeks;
    _currentPlanWeekIdx = idx;
}
let _currentPlanWeeks = [];
let _currentPlanWeekIdx = 0;

// ── Download Training Plan as CSV ─────────────────────────────────────────────
function initDownloadButton(plan, recommendations, hypothesis) {
    const btn = document.getElementById('downloadPlanBtn');
    if (!btn || !plan.length) return;
    btn.classList.remove('hidden');
    btn.onclick = () => {
        const q  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const row = (...cells) => cells.map(q).join(',');
        const blank = '';
        const targets = recommendations.weeklyTargets || {};

        const sections = [

            // ── SECTION 1: Plan Summary ───────────────────────────────────────
            row('PLAN SUMMARY', ''),
            row('Field', 'Value'),
            row('Feasibility', `${hypothesis.feasibility} (${hypothesis.feasibilityScore}/100)`),
            row('Summary', hypothesis.summary || ''),
            row('Coach Note', recommendations.coachNote || ''),
            blank,

            // ── SECTION 2: Weekly Targets ─────────────────────────────────────
            row('WEEKLY TARGETS', ''),
            row('Metric', 'Target'),
            row('Distance (km)',     targets.distanceKm    ?? 'N/A'),
            row('Calories (kcal)',   targets.kcal          ?? 'N/A'),
            row('Active Hours (hrs)',targets.activeHours   ?? 'N/A'),
            row('Long Run (km)',     targets.longRunKm     ?? 'N/A'),
            blank,

            // ── SECTION 3: Weekly Training Plan ──────────────────────────────
            row('WEEKLY TRAINING PLAN', ''),
            row('Day', 'Workout', 'Duration', 'Intensity', 'Target HR', 'Purpose'),
            ...plan.map(d => row(d.day, d.workout, d.duration, d.intensity, d.targetHR || 'N/A', d.purpose)),
            blank,

            // ── SECTION 4: Milestones ─────────────────────────────────────────
            row('MILESTONES', ''),
            row('Week', 'Target'),
            ...(recommendations.milestones || []).map(m => row(`Week ${m.week}`, m.target)),
        ];

        const csv  = sections.join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = 'athleteiq-training-plan.csv';
        a.click();
        URL.revokeObjectURL(url);
    };
    lucide.createIcons();
}

// ===== GOOGLE CALENDAR SCHEDULING =====
let _weeklyTrainingPlan = null;

function initCalendarSection(plan) {
    _weeklyTrainingPlan = plan;
    const section = document.getElementById('calendarSection');
    if (!section) return;
    section.classList.remove('hidden');
    checkGcalStatus();
    lucide.createIcons();
}

// ── Check connection status ───────────────────────────────────────────────────
async function checkGcalStatus() {
    try {
        const res  = await fetch('/api/auth/google-calendar/status', { credentials: 'same-origin' });
        const data = await res.json();
        updateGcalUI(data.connected, data.email);
    } catch (_) {}
}

function updateGcalUI(connected, email) {
    const notConn  = document.getElementById('gcalNotConnected');
    const connArea = document.getElementById('gcalConnected');
    const emailEl  = document.getElementById('gcalConnectedEmail');
    const viewBtn  = document.getElementById('viewCalendarBtn');
    const schedBtn = document.getElementById('scheduleBtn');

    if (connected && email) {
        notConn?.classList.add('hidden');
        connArea?.classList.remove('hidden');
        if (emailEl) emailEl.textContent = email;
        if (viewBtn)  viewBtn.disabled  = false;
        if (schedBtn) schedBtn.disabled = false;
    } else {
        notConn?.classList.remove('hidden');
        connArea?.classList.add('hidden');
        if (viewBtn)  viewBtn.disabled  = true;
        if (schedBtn) schedBtn.disabled = true;
    }
    lucide.createIcons();
}

// ── Connect Google Calendar (opens popup) ────────────────────────────────────
document.addEventListener('click', (e) => {
    if (!e.target.closest('#connectGcalBtn')) return;
    const popup = window.open('/auth/google-calendar', 'Connect Google Calendar', 'width=500,height=640,scrollbars=yes');
    window.addEventListener('message', async (event) => {
        if (event.data?.type === 'GCAL_CONNECTED') {
            if (popup && !popup.closed) popup.close();
            updateGcalUI(true, event.data.email);
        }
    }, { once: true });
    // Poll in case popup was blocked
    const poll = setInterval(async () => {
        if (popup?.closed) { clearInterval(poll); await checkGcalStatus(); }
    }, 1000);
});

// ── Disconnect ────────────────────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
    if (!e.target.closest('#disconnectGcalBtn')) return;
    await fetch('/api/auth/google-calendar/disconnect', { method: 'POST', credentials: 'same-origin' });
    updateGcalUI(false, null);
    document.getElementById('upcomingResult')?.classList.add('hidden');
    document.getElementById('scheduleResult')?.classList.add('hidden');
});

// ── View Upcoming Calendar Events ────────────────────────────────────────────
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#viewCalendarBtn');
    if (!btn) return;

    btn.disabled = true;
    const ogHtml = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="analyse-btn-icon spin-icon"></i> Loading…';
    lucide.createIcons();

    const loader = document.getElementById('upcomingLoader');
    const result = document.getElementById('upcomingResult');
    loader.classList.remove('hidden');
    result.classList.add('hidden');

    try {
        const res  = await fetch('/api/calendar/upcoming?days=14', { credentials: 'same-origin' });
        const data = await res.json();
        loader.classList.add('hidden');
        result.classList.remove('hidden');

        if (data.error) {
            result.innerHTML = `<div class="analysis-error"><p>${data.error}</p>${data.hint ? `<p style="margin-top:.4rem;opacity:.7;font-size:.82rem">${data.hint}</p>` : ''}</div>`;
        } else if (!data.events || !data.events.trim()) {
            result.innerHTML = `<div class="coach-note glass-panel"><p style="opacity:.7">No upcoming events in the next ${data.days} days.</p></div>`;
        } else {
            result.innerHTML = `<div class="coach-note glass-panel" style="white-space:pre-wrap;font-size:.85rem">
                <p style="font-weight:600;margin-bottom:.6rem;opacity:.7;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em">📅 Upcoming ${data.days} days · ${data.email}</p>
                ${data.events}</div>`;
        }
    } catch (err) {
        document.getElementById('upcomingLoader').classList.add('hidden');
        result.classList.remove('hidden');
        result.innerHTML = `<div class="analysis-error"><p>Failed to load calendar: ${err.message}</p></div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = ogHtml;
        lucide.createIcons();
    }
});

// ── Schedule Workouts into Calendar ──────────────────────────────────────────
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#scheduleBtn');
    if (!btn) return;

    if (!_weeklyTrainingPlan?.length) {
        alert('No training plan found. Please run "Analyse My Goal" first.');
        return;
    }

    const durationWeeks = parseInt(document.getElementById('calDurationWeeks')?.value) || 4;
    const startDate     = document.getElementById('calStartDate')?.value || null;

    btn.disabled = true;
    const ogHtml = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="analyse-btn-icon spin-icon"></i> Scheduling…';
    lucide.createIcons();

    const loader = document.getElementById('scheduleLoader');
    const result = document.getElementById('scheduleResult');
    loader.classList.remove('hidden');
    result.classList.add('hidden');

    try {
        const res  = await fetch('/api/calendar/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ weeklyTrainingPlan: _weeklyTrainingPlan, durationWeeks, startDate }),
        });
        const data = await res.json();

        loader.classList.add('hidden');
        result.classList.remove('hidden');

        if (res.status === 401) {
            result.innerHTML = `<div class="analysis-error"><p>Please connect your Google Calendar first, then try again.</p></div>`;
            updateGcalUI(false, null);
        } else if (data.error) {
            result.innerHTML = `<div class="analysis-error"><p>${data.error}</p>${data.hint ? `<p style="margin-top:.5rem;opacity:.7">${data.hint}</p>` : ''}</div>`;
        } else {
            result.innerHTML = `<div class="coach-note glass-panel" style="white-space:pre-wrap">
                <p style="font-weight:600;margin-bottom:.6rem;color:var(--accent)">✅ Workouts Scheduled!</p>
                ${data.summary}</div>`;
        }
    } catch (err) {
        loader.classList.add('hidden');
        result.classList.remove('hidden');
        result.innerHTML = `<div class="analysis-error"><p>Scheduling failed: ${err.message}</p></div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = ogHtml;
        lucide.createIcons();
    }
});

// ===== AI NUTRITION PLAN (RAG + Firecrawl) =====
let _nutritionMeta = null;

function initNutritionSection(weeklySummary) {
    _nutritionMeta = weeklySummary || {};
    const section = document.getElementById('nutritionSection');
    if (section) {
        section.classList.remove('hidden');
        lucide.createIcons();
    }
}

document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#nutritionBtn');
    if (!btn) return;

    btn.disabled = true;
    const ogHtml = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="analyse-btn-icon spin-icon"></i> Generating…';
    lucide.createIcons();

    const loader = document.getElementById('nutritionLoader');
    const result = document.getElementById('nutritionResult');
    loader.classList.remove('hidden');
    result.classList.add('hidden');

    try {
        const age          = parseInt(document.getElementById('f-age')?.value)      || 25;
        const sex          = document.getElementById('f-sex')?.value                || 'male';
        const weight       = parseFloat(document.getElementById('f-weight')?.value) || 70;
        const height       = parseFloat(document.getElementById('f-height')?.value) || 170;
        const goal         = document.getElementById('goalSelect')?.value           || 'General Fitness';
        const durationWeeks = parseInt(document.getElementById('f-duration')?.value) || 8;

        const allergies = document.getElementById('nutrition-allergies')?.value.trim() || '';
        const dislikes  = document.getElementById('nutrition-dislikes')?.value.trim()  || '';

        const body = {
            goal, age, sex, weight, height, durationWeeks,
            weeklyDistKm:  _nutritionMeta?.weeklyDistKm  ?? null,
            weeklyHours:   _nutritionMeta?.weeklyHours   ?? null,
            weeklyKcal:    _nutritionMeta?.weeklyKcal    ?? null,
            allergies:     allergies || null,
            dislikes:      dislikes  || null,
        };

        const res = await fetch('/api/nutrition', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        loader.classList.add('hidden');
        result.classList.remove('hidden');

        if (data.error) {
            result.innerHTML = `<div class="analysis-error"><p>${data.error}</p></div>`;
        } else {
            const plan = data.plan;
            const ragBadge = data.ragUsed
                ? `<span class="badge" style="font-size:.7rem;padding:2px 8px;margin-left:.5rem">Grounded via Firecrawl</span>`
                : `<span class="badge" style="font-size:.7rem;padding:2px 8px;margin-left:.5rem;opacity:.6">Model Knowledge</span>`;

            // Render prose plan or structured JSON
            if (plan.prose) {
                result.innerHTML = `
                    <p class="sub-title">Your Nutrition Plan ${ragBadge}</p>
                    <div class="coach-note glass-panel nutrition-prose">${markdownToHtml(plan.prose)}</div>`;
            } else {
                result.innerHTML = `<p class="sub-title">Your Nutrition Plan ${ragBadge}</p>` + renderNutritionPlan(plan);
            }
        }
    } catch (err) {
        loader.classList.add('hidden');
        result.classList.remove('hidden');
        result.innerHTML = `<div class="analysis-error"><p>Failed: ${err.message}</p></div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = ogHtml;
        lucide.createIcons();
    }
});

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/**
 * Markdown → HTML converter for AI-generated EDA and nutrition reports.
 * Handles: headings (#–####), **bold**, *italic*, bullet/numbered lists,
 * horizontal rules, code spans, and blank-line paragraph breaks.
 */
function markdownToHtml(md) {
    if (!md) return '';

    // ── Step 1: normalise line endings ──────────────────────────────────────
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html     = '';
    let inList   = false;
    let listTag  = '';

    const closeList = () => {
        if (inList) { html += `</${listTag}>`; inList = false; listTag = ''; }
    };

    // Escape HTML entities FIRST, then apply inline markdown patterns
    const esc = (t) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const inline = (text) =>
        esc(text)
            .replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.+?)\*\*/gs,     '<strong>$1</strong>')
            .replace(/\*([^*\n]+?)\*/g,     '<em>$1</em>')
            .replace(/`([^`]+)`/g,          '<code>$1</code>');

    // Strip any leftover raw heading markers inside text (e.g. #### that leaked)
    const stripHeadingMarkers = (t) => t.replace(/^#+\s*/, '');

    for (const raw of lines) {
        const line = raw.trimEnd();
        const trim = line.trim();

        // ── Headings (with or without trailing space) ────────────────────
        const hm = trim.match(/^(#{1,4})\s*(.*)/);
        if (hm) {
            closeList();
            const level  = hm[1].length;            // 1–4
            const hLevel = level <= 2 ? 'h3' : 'h4'; // map # and ## → h3, ### and #### → h4
            html += `<${hLevel}>${inline(hm[2])}</${hLevel}>`;
            continue;
        }

        // ── Horizontal rule ──────────────────────────────────────────────
        if (/^[-*_]{3,}$/.test(trim)) { closeList(); html += '<hr>'; continue; }

        // ── Bullet list (-, *, +, with optional leading spaces) ─────────
        const bm = line.match(/^[\s]*[-*+]\s+(.*)/);
        if (bm) {
            if (!inList || listTag !== 'ul') { closeList(); html += '<ul>'; inList = true; listTag = 'ul'; }
            html += `<li>${inline(bm[1])}</li>`;
            continue;
        }

        // ── Numbered list ────────────────────────────────────────────────
        const nm = line.match(/^[\s]*\d+[.)]\s+(.*)/);
        if (nm) {
            if (!inList || listTag !== 'ol') { closeList(); html += '<ol>'; inList = true; listTag = 'ol'; }
            html += `<li>${inline(nm[1])}</li>`;
            continue;
        }

        // ── Blank line → paragraph break ────────────────────────────────
        if (trim === '') { closeList(); continue; }

        // ── Normal paragraph ─────────────────────────────────────────────
        closeList();
        html += `<p>${inline(stripHeadingMarkers(line))}</p>`;
    }
    closeList();
    return html;
}

function renderNutritionPlan(plan) {
    let html = '';
    if (plan.dailyCalories || plan.macros) {
        html += `<div class="forecast-subsection glass-panel" style="margin-top:1rem">
            <p class="sub-title">Daily Targets</p>
            ${plan.dailyCalories ? `<div class="sub-item"><strong>Calories:</strong> ${plan.dailyCalories} kcal/day</div>` : ''}
            ${plan.macros ? Object.entries(plan.macros).map(([k,v]) => `<div class="sub-item"><strong>${k}:</strong> ${v}</div>`).join('') : ''}
        </div>`;
    }
    if (plan.mealTiming && plan.mealTiming.length) {
        html += `<div class="forecast-subsection glass-panel" style="margin-top:1rem">
            <p class="sub-title">Meal Timing</p>
            ${plan.mealTiming.map(m => `<div class="plan-day"><span class="plan-day-name">${m.time||m.meal||''}</span><span class="plan-workout">${m.detail||m.foods||''}</span></div>`).join('')}
        </div>`;
    }
    if (plan.hydration) {
        html += `<div class="forecast-subsection glass-panel" style="margin-top:1rem">
            <p class="sub-title">Hydration</p>
            <div class="sub-item">${typeof plan.hydration === 'string' ? plan.hydration : JSON.stringify(plan.hydration)}</div>
        </div>`;
    }
    if (plan.supplements && plan.supplements.length) {
        html += `<div class="forecast-subsection glass-panel" style="margin-top:1rem">
            <p class="sub-title">Supplements</p>
            ${plan.supplements.map(s => `<div class="sub-item">${typeof s === 'string' ? s : (s.name + ': ' + (s.detail||''))}</div>`).join('')}
        </div>`;
    }
    // Fallback: dump remaining keys
    if (!html) {
        html = `<div class="coach-note glass-panel" style="white-space:pre-wrap">${escapeHtml(JSON.stringify(plan, null, 2))}</div>`;
    }
    return html;
}
