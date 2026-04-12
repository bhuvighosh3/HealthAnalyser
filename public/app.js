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
const analyseBtn = document.getElementById('analyseBtn');
const analysisLoader = document.getElementById('analysisLoader');
const analysisResults = document.getElementById('analysisResults');
const insightsContainer = document.getElementById('insightsContainer');

// Store chart instances for cleanup
let chartInstances = [];

analyseBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
    // Disable button, show loader
    analyseBtn.disabled = true;
    analyseBtn.innerHTML = '<i data-lucide="loader-2" class="analyse-btn-icon spin-icon"></i> Analysing...';
    lucide.createIcons();
    analysisLoader.classList.remove('hidden');
    analysisResults.classList.add('hidden');

    // Destroy old charts
    chartInstances.forEach(c => c.destroy());
    chartInstances = [];

    try {
        const res = await fetch('/api/analyse', { method: 'POST' });
        const data = await res.json();

        if (data.error) {
            alert(data.error);
            return;
        }

        analysisLoader.classList.add('hidden');
        analysisResults.classList.remove('hidden');

        renderCharts(data.charts);
        renderInsights(data.insights);

        // Smooth scroll to results
        analysisResults.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
        console.error('Analysis error:', err);
        alert('Failed to run analysis. Check the console for details.');
    } finally {
        analyseBtn.disabled = false;
        analyseBtn.innerHTML = '<i data-lucide="bar-chart-3" class="analyse-btn-icon"></i> Analyse My Performance';
        analysisLoader.classList.add('hidden');
        lucide.createIcons();
    }
}

function renderCharts(charts) {
    // Global Chart.js defaults for dark theme
    Chart.defaults.color = 'hsl(220, 10%, 60%)';
    Chart.defaults.borderColor = 'hsla(0, 0%, 100%, 0.06)';

    const orangeGradientFill = (ctx) => {
        const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
        gradient.addColorStop(0, 'hsla(12, 100%, 60%, 0.4)');
        gradient.addColorStop(1, 'hsla(12, 100%, 60%, 0.02)');
        return gradient;
    };

    // 1. Distance Trend (Line)
    if (charts.distanceTrend) {
        const ctx = document.getElementById('distanceChart').getContext('2d');
        chartInstances.push(new Chart(ctx, {
            type: 'line',
            data: {
                labels: charts.distanceTrend.labels,
                datasets: [{
                    label: 'Distance (km)',
                    data: charts.distanceTrend.data,
                    borderColor: 'hsl(12, 100%, 60%)',
                    backgroundColor: orangeGradientFill,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 4,
                    pointBackgroundColor: 'hsl(12, 100%, 60%)',
                    pointBorderColor: 'hsl(220, 20%, 8%)',
                    pointBorderWidth: 2,
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } },
                    y: { beginAtZero: true }
                }
            }
        }));
    }

    // 2. Pace Trend (Line)
    if (charts.paceTrend) {
        const ctx = document.getElementById('paceChart').getContext('2d');
        chartInstances.push(new Chart(ctx, {
            type: 'line',
            data: {
                labels: charts.paceTrend.labels,
                datasets: [{
                    label: 'Pace (min/km)',
                    data: charts.paceTrend.data,
                    borderColor: 'hsl(330, 80%, 50%)',
                    backgroundColor: (ctx) => {
                        const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
                        gradient.addColorStop(0, 'hsla(330, 80%, 50%, 0.3)');
                        gradient.addColorStop(1, 'hsla(330, 80%, 50%, 0.02)');
                        return gradient;
                    },
                    fill: true,
                    tension: 0.35,
                    pointRadius: 4,
                    pointBackgroundColor: 'hsl(330, 80%, 50%)',
                    pointBorderColor: 'hsl(220, 20%, 8%)',
                    pointBorderWidth: 2,
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } },
                    y: { beginAtZero: false, reverse: true, title: { display: true, text: 'min/km' } }
                }
            }
        }));
    }

    // 3. Weekly Volume (Bar)
    if (charts.weeklyVolume) {
        const ctx = document.getElementById('weeklyChart').getContext('2d');
        chartInstances.push(new Chart(ctx, {
            type: 'bar',
            data: {
                labels: charts.weeklyVolume.labels,
                datasets: [{
                    label: 'Weekly km',
                    data: charts.weeklyVolume.data,
                    backgroundColor: 'hsla(12, 100%, 60%, 0.7)',
                    borderColor: 'hsl(12, 100%, 60%)',
                    borderWidth: 1,
                    borderRadius: 8,
                    hoverBackgroundColor: 'hsl(12, 100%, 60%)',
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false } },
                    y: { beginAtZero: true, title: { display: true, text: 'km' } }
                }
            }
        }));
    }

    // 4. Activity Types (Doughnut)
    if (charts.activityTypes) {
        const typeColors = [
            'hsl(12, 100%, 60%)',
            'hsl(330, 80%, 50%)',
            'hsl(200, 80%, 55%)',
            'hsl(45, 90%, 55%)',
            'hsl(160, 70%, 45%)',
            'hsl(270, 60%, 55%)',
        ];
        const ctx = document.getElementById('typesChart').getContext('2d');
        chartInstances.push(new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: charts.activityTypes.labels,
                datasets: [{
                    data: charts.activityTypes.data,
                    backgroundColor: typeColors.slice(0, charts.activityTypes.labels.length),
                    borderColor: 'hsl(220, 20%, 8%)',
                    borderWidth: 3,
                    hoverOffset: 8,
                }]
            },
            options: {
                responsive: true,
                cutout: '60%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 16, font: { size: 12 } }
                    }
                }
            }
        }));
    }
}

function renderInsights(insights) {
    insightsContainer.innerHTML = '';
    if (!insights || !insights.length) return;

    insights.forEach(insight => {
        const card = document.createElement('div');
        card.className = 'insight-card glass-panel';
        card.innerHTML = `
            <div class="insight-header">
                <i data-lucide="${insight.icon || 'info'}" class="insight-icon"></i>
                <span class="insight-title">${insight.title}</span>
            </div>
            <p class="insight-text">${insight.text}</p>
        `;
        insightsContainer.appendChild(card);
    });

    lucide.createIcons();
}

