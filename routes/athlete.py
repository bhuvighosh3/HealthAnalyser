import requests
from flask import Blueprint, jsonify
import shared

bp = Blueprint('athlete', __name__)


@bp.route('/api/athlete')
def get_athlete():
    try:
        shared.ensure_valid_token()
        res = requests.get(
            'https://www.strava.com/api/v3/athlete',
            headers={'Authorization': f'Bearer {shared.STRAVA_ACCESS_TOKEN}'},
        )
        return jsonify(res.json())
    except Exception:
        return jsonify({'error': 'Failed to fetch athlete data'}), 500


@bp.route('/api/athlete/stats/<athlete_id>')
def get_athlete_stats(athlete_id):
    try:
        shared.ensure_valid_token()
        res = requests.get(
            f'https://www.strava.com/api/v3/athletes/{athlete_id}/stats',
            headers={'Authorization': f'Bearer {shared.STRAVA_ACCESS_TOKEN}'},
        )
        return jsonify(res.json())
    except Exception:
        return jsonify({'error': 'Failed to fetch athlete stats'}), 500
