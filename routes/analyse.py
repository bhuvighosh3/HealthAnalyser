import re
import json
import requests
from flask import Blueprint, request, jsonify
from vertexai.generative_models import GenerativeModel
import shared

bp = Blueprint('analyse', __name__)


@bp.route('/api/analyse', methods=['POST'])
def analyse():
    try:
        shared.ensure_valid_token()
        body    = request.get_json() or {}
        goal    = body.get('goal',    'General Fitness')
        focus   = body.get('focus',   'Multiple')
        context = body.get('context', 'None')
        print(f'[Analysis] Goal: {goal}, Focus: {focus}')

        hdrs       = {'Authorization': f'Bearer {shared.STRAVA_ACCESS_TOKEN}'}
        activities = requests.get(
            'https://www.strava.com/api/v3/athlete/activities?per_page=30', headers=hdrs
        ).json()

        if not activities:
            return jsonify({'error': 'No activities found to analyse.'})

        prompt = f"""You are a professional athletic performance coach and data scientist.
Given the following 30 most recent Strava activities (JSON):
{json.dumps(activities)}

User Preferences:
- Primary Goal: {goal}
- Main Focus: {focus}
- Additional Context: {context}

Return ONLY a valid JSON object (no markdown, no code fences):
{{
  "metrics": {{
    "consistencyScore": 0-100,
    "avgSufferScore": number
  }},
  "insights": [
    {{
      "title": "...",
      "icon": "trending-up | gauge | flame | lightbulb | activity",
      "text": "..."
    }}
  ]
}}

- consistencyScore: based on frequency and gaps (100 = highly regular).
- avgSufferScore: average effort across recent activities.
- Reference actual numbers. Include at least 4 insights addressing "{focus}"."""

        model    = GenerativeModel('gemini-1.5-flash')
        response = model.generate_content(prompt)
        text     = response.text.strip()
        text     = re.sub(r'^```json\s*', '', text, flags=re.IGNORECASE)
        text     = re.sub(r'```$', '', text).strip()
        text     = re.sub(r'[\x00-\x1F\x7F-\x9F]', ' ', text)

        analysis = json.loads(text)
        print('[AI] Analysis generated via Vertex AI gemini-1.5-flash')
        return jsonify(analysis)

    except Exception as e:
        print(f'Analysis error: {e}')
        return jsonify({'error': f'Failed to generate analysis: {str(e)}'}), 500
