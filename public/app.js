let currentAthleteId = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Fetch athlete profile
        const profileRes = await fetch('/api/athlete');
        if (!profileRes.ok) throw new Error('Failed to fetch profile');
        const athlete = await profileRes.json();

        currentAthleteId = athlete.id;
        renderProfile(athlete);

        // Fetch athlete stats
        const statsRes = await fetch(`/api/athlete/stats/${athlete.id}`);
        if (!statsRes.ok) throw new Error('Failed to fetch stats');
        const stats = await statsRes.json();

        renderStats(stats);
    } catch (err) {
        console.error(err);
        alert('Could not load data. Ensure the backend proxy is running and your tokens are valid.');
    }
});

function renderProfile(athlete) {
    const container = document.getElementById('profileContainer');
    const locationStr = [athlete.city, athlete.country].filter(Boolean).join(', ');

    container.innerHTML = `
        <img src="${athlete.profile_medium || 'https://via.placeholder.com/50'}" alt="Profile" class="avatar">
        <div class="profile-info">
            <span class="user-name">${athlete.firstname} ${athlete.lastname}</span>
            <span class="location">${locationStr || 'Strava Athlete'}</span>
        </div>
    `;
}

function renderStats(stats) {
    // Utilities
    const formatDistance = (meters) => (meters / 1000).toFixed(1);
    const formatTime = (seconds) => (seconds / 3600).toFixed(1);

    // --- All Time Runs ---
    const allRuns = stats.all_run_totals || { count: 0, distance: 0, moving_time: 0, elevation_gain: 0 };

    document.querySelector('#stat-activities .stat-value').innerText = allRuns.count;
    document.querySelector('#stat-distance .stat-value').innerText = formatDistance(allRuns.distance);
    document.querySelector('#stat-time .stat-value').innerText = formatTime(allRuns.moving_time);
    document.querySelector('#stat-elevation .stat-value').innerText = Math.round(allRuns.elevation_gain);

    removeSkeleton('#stat-activities');
    removeSkeleton('#stat-distance');
    removeSkeleton('#stat-time');
    removeSkeleton('#stat-elevation');

    // --- Recent Runs (4 weeks) ---
    const recentRuns = stats.recent_run_totals || { distance: 0, moving_time: 0, count: 0 };
    document.getElementById('recent-dist').innerText = `${formatDistance(recentRuns.distance)} km`;
    document.getElementById('recent-time').innerText = `${formatTime(recentRuns.moving_time)} hours`;
    document.getElementById('recent-count').innerText = recentRuns.count;

    removeSkeleton('#recent-dist');
    removeSkeleton('#recent-time');
    removeSkeleton('#recent-count');

    // --- YTD Runs ---
    const ytdRuns = stats.ytd_run_totals || { distance: 0, moving_time: 0, count: 0 };
    document.getElementById('ytd-dist').innerText = `${formatDistance(ytdRuns.distance)} km`;
    document.getElementById('ytd-time').innerText = `${formatTime(ytdRuns.moving_time)} hours`;
    document.getElementById('ytd-count').innerText = ytdRuns.count;

    removeSkeleton('#ytd-dist');
    removeSkeleton('#ytd-time');
    removeSkeleton('#ytd-count');
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
const chatToggle = document.getElementById('chatToggle');
const chatBox = document.getElementById('chatBox');
const chatClose = document.getElementById('chatClose');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatMessages = document.getElementById('chatMessages');

chatToggle.addEventListener('click', () => chatBox.classList.remove('hidden'));
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, id: currentAthleteId })
        });
        const data = await response.json();

        const loaderEl = document.getElementById(loaderId);
        if (loaderEl) loaderEl.innerText = data.reply || data.error;

    } catch (err) {
        const loaderEl = document.getElementById(loaderId);
        if (loaderEl) loaderEl.innerText = "Error trying to reach the assistant.";
    }
}

function addMessage(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    msgDiv.innerText = text;

    // Assign an ID for updating loaders
    const msgId = 'msg-' + Date.now();
    msgDiv.id = msgId;

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    lucide.createIcons(); // Reactivate icons if any injected
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
        const statsPromise    = fetch('/api/stats').then(r => r.json());
        const forecastPromise = fetch('/api/forecast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
        const statsData = await fetch('/api/stats').then(r => r.json());
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
function renderForecastResults({ hypothesis, recommendations }) {

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
    const wt = recommendations.weeklyTargets || {};
    document.getElementById('weeklyTargets').innerHTML = `
        <p class="sub-title">Weekly Targets</p>
        <div class="targets-row">
            <div class="target-chip"><div class="t-val">${wt.distanceKm ?? '—'} km</div><div class="t-label">Distance</div></div>
            <div class="target-chip"><div class="t-val">${wt.kcal ? Number(wt.kcal).toLocaleString() : '—'}</div><div class="t-label">Calories</div></div>
            <div class="target-chip"><div class="t-val">${wt.activeHours ?? '—'} hrs</div><div class="t-label">Active Time</div></div>
            <div class="target-chip"><div class="t-val">${wt.longRunKm ?? '—'} km</div><div class="t-label">Long Run</div></div>
        </div>`;

    // 7. Training plan
    const plan = recommendations.weeklyTrainingPlan || [];
    initCalendarSection(plan); // show calendar button if configured
    document.getElementById('trainingPlan').innerHTML = `
        <p class="sub-title">Weekly Training Plan</p>
        ${plan.map(d => `
            <div class="plan-day">
                <span class="plan-day-name">${d.day}</span>
                <span class="plan-workout">${d.workout}
                    <small>${d.duration}${d.targetHR && d.targetHR !== 'N/A' ? ' · ' + d.targetHR : ''} · ${d.purpose}</small>
                </span>
                <span class="plan-intensity intensity-${(d.intensity||'moderate').toLowerCase()}">${d.intensity||''}</span>
            </div>`).join('')}`;

    // 8. Nutrition
    const nutrition = recommendations.nutritionTips || [];
    document.getElementById('nutritionTips').innerHTML = `
        <p class="sub-title">Nutrition</p>
        ${nutrition.map(n => `
            <div class="nutrition-tip">
                <span class="nutrition-tip-icon"><i data-lucide="${n.icon || 'apple'}"></i></span>
                <div><div class="nutrition-tip-title">${n.title}</div><div class="nutrition-tip-detail">${n.detail}</div></div>
            </div>`).join('')}`;

    // 9. Recovery
    const recovery = recommendations.recoveryAdvice || [];
    const recHtml = recovery.length ? `
        ${recovery.map(r => `<div class="sub-item"><strong>${r.title}:</strong> ${r.detail}</div>`).join('')}` : '';
    if (recHtml) {
        document.getElementById('nutritionTips').innerHTML +=
            `<p class="sub-title" style="margin-top:1rem">Recovery</p>${recHtml}`;
    }

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

// ===== GOOGLE CALENDAR SCHEDULING =====
let _weeklyTrainingPlan = null; // set by renderForecastResults

function initCalendarSection(plan) {
    _weeklyTrainingPlan = plan;
    const section = document.getElementById('calendarSection');
    if (!section) return;
    section.classList.remove('hidden');
    lucide.createIcons();
}

document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#scheduleBtn');
    if (!btn) return;

    if (!_weeklyTrainingPlan || !_weeklyTrainingPlan.length) {
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
        const res = await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ weeklyTrainingPlan: _weeklyTrainingPlan, durationWeeks, startDate })
        });
        const data = await res.json();

        loader.classList.add('hidden');
        result.classList.remove('hidden');

        if (data.error) {
            result.innerHTML = `<div class="analysis-error"><p>${data.error}</p>${data.hint ? `<p style="margin-top:.5rem;opacity:.7">${data.hint}</p>` : ''}</div>`;
        } else {
            result.innerHTML = `<div class="coach-note glass-panel" style="white-space:pre-wrap">${data.summary}</div>`;
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
