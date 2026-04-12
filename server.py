import os
import re
import json
import time
import asyncio
import sqlite3
import requests
from dotenv import load_dotenv
from flask import Flask, request, jsonify, redirect, send_from_directory
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

load_dotenv()

app = Flask(__name__, static_folder='public', static_url_path='')
PORT = int(os.getenv('PORT', 3000))

# --- Global Strava Tokens ---
STRAVA_ACCESS_TOKEN = os.getenv('STRAVA_ACCESS_TOKEN', '')
STRAVA_REFRESH_TOKEN = os.getenv('STRAVA_REFRESH_TOKEN', '')
STRAVA_EXPIRES_AT = os.getenv('STRAVA_EXPIRES_AT', '0')

# --- In-Memory SQLite ---
db_conn = sqlite3.connect(':memory:', check_same_thread=False)
db_conn.row_factory = sqlite3.Row
db_conn.execute("""
    CREATE TABLE IF NOT EXISTS run_stats (
        period TEXT PRIMARY KEY,
        run_count INTEGER,
        distance_m REAL,
        moving_time_s INTEGER,
        elevation_gain_m REAL
    )
""")
db_conn.commit()


# --- Token Helpers ---
def update_env(new_tokens: dict):
    try:
        with open('.env', 'r') as f:
            content = f.read()
        for key, value in new_tokens.items():
            if re.search(f'^{key}=', content, re.MULTILINE):
                content = re.sub(f'^{key}=.*', f'{key}={value}', content, flags=re.MULTILINE)
            else:
                content += f'\n{key}={value}'
        with open('.env', 'w') as f:
            f.write(content)
    except Exception as e:
        print(f"Failed to update .env: {e}")


def ensure_valid_token():
    global STRAVA_ACCESS_TOKEN, STRAVA_REFRESH_TOKEN, STRAVA_EXPIRES_AT
    now = int(time.time())
    if STRAVA_EXPIRES_AT and now >= (int(STRAVA_EXPIRES_AT) - 300) and STRAVA_REFRESH_TOKEN:
        print("Token expiring soon, refreshing...")
        try:
            res = requests.post('https://www.strava.com/oauth/token', json={
                'client_id': os.getenv('STRAVA_CLIENT_ID'),
                'client_secret': os.getenv('STRAVA_CLIENT_SECRET'),
                'grant_type': 'refresh_token',
                'refresh_token': STRAVA_REFRESH_TOKEN
            })
            data = res.json()
            if 'access_token' in data:
                STRAVA_ACCESS_TOKEN = data['access_token']
                STRAVA_REFRESH_TOKEN = data['refresh_token']
                STRAVA_EXPIRES_AT = str(data['expires_at'])
                update_env({
                    'STRAVA_ACCESS_TOKEN': STRAVA_ACCESS_TOKEN,
                    'STRAVA_REFRESH_TOKEN': STRAVA_REFRESH_TOKEN,
                    'STRAVA_EXPIRES_AT': STRAVA_EXPIRES_AT
                })
                print("✅ Token refreshed!")
        except Exception as e:
            print(f"Failed to refresh token: {e}")


def init_database():
    try:
        ensure_valid_token()
        if not STRAVA_ACCESS_TOKEN:
            return
        headers = {'Authorization': f'Bearer {STRAVA_ACCESS_TOKEN}'}
        athlete = requests.get('https://www.strava.com/api/v3/athlete', headers=headers).json()
        stats_res = requests.get(f'https://www.strava.com/api/v3/athletes/{athlete["id"]}/stats', headers=headers)
        if not stats_res.ok:
            return
        stats = stats_res.json()

        cursor = db_conn.cursor()
        for period, data in [
            ('recent', stats.get('recent_run_totals', {})),
            ('ytd', stats.get('ytd_run_totals', {})),
            ('all_time', stats.get('all_run_totals', {}))
        ]:
            cursor.execute(
                'INSERT OR REPLACE INTO run_stats VALUES (?, ?, ?, ?, ?)',
                (period, data.get('count', 0), data.get('distance', 0),
                 data.get('moving_time', 0), data.get('elevation_gain', 0))
            )
        db_conn.commit()
        print('✅ In-memory SQLite DB populated successfully')
    except Exception as e:
        print(f'Failed to init DB: {e}')


init_database()


# --- ADK Tool ---
def query_run_stats(sql: str) -> str:
    """Execute a SQL SELECT query against the run_stats table and return results as JSON.

    The run_stats table has columns:
    - period TEXT: one of 'recent' (last 4 weeks), 'ytd' (year to date), 'all_time'
    - run_count INTEGER: number of runs
    - distance_m REAL: total distance in meters
    - moving_time_s INTEGER: total moving time in seconds
    - elevation_gain_m REAL: total elevation gain in meters

    Args:
        sql: A SQL SELECT query against the run_stats table.

    Returns:
        JSON string with query results.
    """
    try:
        cursor = db_conn.cursor()
        cursor.execute(sql)
        rows = [dict(row) for row in cursor.fetchall()]
        return json.dumps(rows)
    except Exception as e:
        return json.dumps({"error": str(e)})


# --- ADK Agent ---
strava_agent = Agent(
    name="strava_assistant",
    model="gemini-2.0-flash",
    instruction="""You are an AI Strava fitness assistant integrated in a sleek health dashboard.
Help users understand their running stats in a conversational, encouraging way.

When users ask about their data, use the query_run_stats tool to fetch it from the database.
Always convert:
- distances from meters to km (divide by 1000, show 1 decimal place)
- times from seconds to hours (divide by 3600, show 1 decimal place)

Keep responses concise and motivating.""",
    tools=[query_run_stats]
)

session_service = InMemorySessionService()
runner = Runner(
    agent=strava_agent,
    app_name="health_analyser",
    session_service=session_service
)


# --- Routes ---
@app.route('/auth')
def auth():
    client_id = os.getenv('STRAVA_CLIENT_ID')
    redirect_uri = f'http://localhost:{PORT}/exchange_token'
    auth_url = (
        f'http://www.strava.com/oauth/authorize?client_id={client_id}'
        f'&response_type=code&redirect_uri={redirect_uri}'
        f'&approval_prompt=force&scope=activity:read_all,read'
    )
    return redirect(auth_url)


@app.route('/exchange_token')
def exchange_token():
    global STRAVA_ACCESS_TOKEN, STRAVA_REFRESH_TOKEN, STRAVA_EXPIRES_AT
    code = request.args.get('code')
    if not code:
        return "Authorization failed!"
    try:
        data = requests.post('https://www.strava.com/oauth/token', json={
            'client_id': os.getenv('STRAVA_CLIENT_ID'),
            'client_secret': os.getenv('STRAVA_CLIENT_SECRET'),
            'code': code,
            'grant_type': 'authorization_code'
        }).json()

        if 'access_token' in data:
            STRAVA_ACCESS_TOKEN = data['access_token']
            STRAVA_REFRESH_TOKEN = data['refresh_token']
            STRAVA_EXPIRES_AT = str(data['expires_at'])
            update_env({
                'STRAVA_ACCESS_TOKEN': STRAVA_ACCESS_TOKEN,
                'STRAVA_REFRESH_TOKEN': STRAVA_REFRESH_TOKEN,
                'STRAVA_EXPIRES_AT': STRAVA_EXPIRES_AT
            })
            init_database()
            return """
                <h2>✅ Authentication Successful!</h2>
                <p>Tokens saved. The server will auto-refresh them when they expire.</p>
                <a href="/">Go back to your Dashboard</a>
            """
        return f"Failed to retrieve tokens: {json.dumps(data)}"
    except Exception as e:
        return f"Error authenticating: {str(e)}", 500


@app.route('/api/athlete')
def get_athlete():
    try:
        ensure_valid_token()
        res = requests.get(
            'https://www.strava.com/api/v3/athlete',
            headers={'Authorization': f'Bearer {STRAVA_ACCESS_TOKEN}'}
        )
        return jsonify(res.json())
    except Exception as e:
        return jsonify({'error': 'Failed to fetch athlete data'}), 500


@app.route('/api/athlete/stats/<athlete_id>')
def get_athlete_stats(athlete_id):
    try:
        ensure_valid_token()
        res = requests.get(
            f'https://www.strava.com/api/v3/athletes/{athlete_id}/stats',
            headers={'Authorization': f'Bearer {STRAVA_ACCESS_TOKEN}'}
        )
        return jsonify(res.json())
    except Exception as e:
        return jsonify({'error': 'Failed to fetch athlete stats'}), 500


@app.route('/api/chat', methods=['POST'])
def chat():
    data = request.get_json()
    user_message = (data.get('message') or '').strip()
    if not user_message:
        return jsonify({'error': 'Missing message'}), 400

    try:
        async def run_agent():
            session = await session_service.get_session(
                app_name="health_analyser", user_id="user", session_id="default"
            )
            if session is None:
                session = await session_service.create_session(
                    app_name="health_analyser", user_id="user", session_id="default"
                )

            content = types.Content(role='user', parts=[types.Part(text=user_message)])
            final_response = ""
            async for event in runner.run_async(
                user_id="user", session_id="default", new_message=content
            ):
                if event.is_final_response() and event.content and event.content.parts:
                    final_response = event.content.parts[0].text
            return final_response

        reply = asyncio.run(run_agent())
        return jsonify({'reply': reply})

    except Exception as e:
        print(f'Chat error: {e}')
        return jsonify({'error': 'Failed to communicate with Assistant'}), 500


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_static(path):
    if path and os.path.exists(os.path.join('public', path)):
        return send_from_directory('public', path)
    return send_from_directory('public', 'index.html')


if __name__ == '__main__':
    print(f'Server running on http://localhost:{PORT}')
    app.run(port=PORT, debug=False)
