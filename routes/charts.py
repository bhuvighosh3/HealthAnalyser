import json
from flask import Blueprint, jsonify
import shared

bp = Blueprint('charts', __name__)


@bp.route('/api/charts', methods=['GET', 'POST'])
def charts():
    try:
        result = shared.get_chart_data()
        data   = json.loads(result)
        if 'error' in data:
            return jsonify({'error': data['error']}), 500
        return jsonify({'charts': data})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
