from flask import Blueprint, request, jsonify
from vertexai.generative_models import GenerativeModel, Part
import shared

bp = Blueprint('chat', __name__)


@bp.route('/api/chat', methods=['POST'])
def chat():
    data         = request.get_json()
    user_message = (data.get('message') or '').strip()
    if not user_message:
        return jsonify({'error': 'Missing message'}), 400

    try:
        model   = GenerativeModel('gemini-1.5-flash', system_instruction=shared.CHAT_SYSTEM)
        session = model.start_chat()
        response = session.send_message(user_message, tools=[shared.STRAVA_TOOLS])

        # Agentic tool-call loop (max 5 rounds)
        for _ in range(5):
            fn_parts = [
                p for p in response.candidates[0].content.parts
                if getattr(p, 'function_call', None) and p.function_call.name
            ]
            if not fn_parts:
                break

            tool_responses = [
                Part.from_function_response(
                    name=p.function_call.name,
                    response={'result': shared.TOOL_DISPATCH.get(
                        p.function_call.name, lambda a: '{}'
                    )(dict(p.function_call.args))},
                )
                for p in fn_parts
            ]
            response = session.send_message(tool_responses, tools=[shared.STRAVA_TOOLS])

        print('[Chat] Reply generated via Vertex AI gemini-1.5-flash')
        return jsonify({'reply': response.text})

    except Exception as e:
        print(f'Chat error: {e}')
        return jsonify({'error': 'Failed to communicate with assistant'}), 500
