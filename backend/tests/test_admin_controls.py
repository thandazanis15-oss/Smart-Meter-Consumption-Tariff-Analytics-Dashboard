from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_admin_users_endpoint_exists_and_lists_registered_accounts():
    response = client.get('/admin/users')
    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload, list)
    assert any(user['username'] == 'Thanda' for user in payload)


def test_admin_notice_endpoint_accepts_broadcast_message():
    response = client.post('/admin/notice', json={'message': 'Service check in progress'})
    assert response.status_code == 200
    payload = response.json()
    assert 'message' in payload
    assert payload['message'] == 'Service check in progress'
