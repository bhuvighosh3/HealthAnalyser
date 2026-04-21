import os
import json
import requests
from flask import Blueprint, request, redirect
import shared

bp = Blueprint('auth', __name__)
PORT = int(os.getenv('PORT', 3000))


@bp.route('/auth')
def auth():
    client_id    = os.getenv('STRAVA_CLIENT_ID')
    redirect_uri = f'http://localhost:{PORT}/exchange_token'
    auth_url = (
        f'http://www.strava.com/oauth/authorize?client_id={client_id}'
        f'&response_type=code&redirect_uri={redirect_uri}'
        f'&approval_prompt=force&scope=activity:read_all,read'
    )
    return redirect(auth_url)


@bp.route('/exchange_token')
def exchange_token():
    code = request.args.get('code')
    if not code:
        return 'Authorization failed!'
    try:
        data = requests.post('https://www.strava.com/oauth/token', json={
            'client_id':     os.getenv('STRAVA_CLIENT_ID'),
            'client_secret': os.getenv('STRAVA_CLIENT_SECRET'),
            'code':          code,
            'grant_type':    'authorization_code',
        }).json()

        if 'access_token' in data:
            shared.set_tokens(data['access_token'], data['refresh_token'], str(data['expires_at']))
            shared.update_env({
                'STRAVA_ACCESS_TOKEN':  shared.STRAVA_ACCESS_TOKEN,
                'STRAVA_REFRESH_TOKEN': shared.STRAVA_REFRESH_TOKEN,
                'STRAVA_EXPIRES_AT':    shared.STRAVA_EXPIRES_AT,
            })
            shared.init_database()
            return """
                <h2>Authentication Successful!</h2>
                <p>Tokens saved. The server will auto-refresh them when they expire.</p>
                <a href="/">Go back to your Dashboard</a>
            """
        return f'Failed to retrieve tokens: {json.dumps(data)}'
    except Exception as e:
        return f'Error authenticating: {str(e)}', 500
