import React, { useState } from 'react';
import { socialFetch } from './socialApi';

// auth form component for login/register
export default function AuthForm({ user, onAuthSuccess, onLogout, themeColor }) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // handle form submit
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (isLogin) {
        const res = await socialFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password })
        });

        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          throw new Error('server returned invalid response');
        }

        let data;
        try {
          data = await res.json();
        } catch {
          throw new Error('server returned empty or malformed response');
        }

        if (!res.ok) {
          throw new Error(data.error || 'login failed');
        }

        setSuccess('welcome back, ' + data.user.username);
        if (data.authToken) {
          localStorage.setItem('music_auth_token', data.authToken);
        }
        onAuthSuccess(data.user);
      } else {
        if (password !== confirmPassword) {
          throw new Error('passwords do not match');
        }

        const res = await socialFetch('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, password })
        });

        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          throw new Error('server returned invalid response');
        }

        let data;
        try {
          data = await res.json();
        } catch {
          throw new Error('server returned empty or malformed response');
        }

        if (!res.ok) {
          throw new Error(data.error || 'registration failed');
        }

        setSuccess('account created successfully');
        if (data.authToken) {
          localStorage.setItem('music_auth_token', data.authToken);
        }
        onAuthSuccess(data.user);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // handle logout click
  const handleLogout = async () => {
    try {
      await onLogout();
      setSuccess('logged out successfully');
    } catch (err) {
      setError('logout failed');
    }
  };

  // show logout option if user is logged in
  if (user) {
    return (
      <div style={{
        padding: '20px',
        background: 'rgba(0, 0, 0, 0.3)',
        borderRadius: '8px',
        border: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.3)`
      }}>
        <div style={{
          textAlign: 'center',
          padding: '20px 0',
          color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
          fontSize: '14px'
        }}>
          logged in as <strong style={{ fontWeight: 'bold' }}>{user.username}</strong>
          {user.is_admin && (
            <span style={{
              marginLeft: '8px',
              padding: '2px 8px',
              background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              color: '#000',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 'bold'
            }}>
              admin
            </span>
          )}
        </div>
        <button
          onClick={handleLogout}
          className="logout-btn"
          style={{
            width: '100%',
            padding: '10px',
            background: 'transparent',
            border: `1px solid #ff4444`,
            borderRadius: '6px',
            color: '#ff4444',
            fontSize: '13px',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          logout
        </button>
      </div>
    );
  }

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    background: 'rgba(0, 0, 0, 0.4)',
    border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    borderRadius: '6px',
    color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    fontSize: '13px',
    outline: 'none',
    transition: 'all 0.2s ease'
  };

  const labelStyle = {
    color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    fontSize: '12px',
    marginBottom: '6px',
    display: 'block'
  };

  const buttonStyle = {
    width: '100%',
    padding: '10px',
    background: loading ? 'rgba(128, 128, 128, 0.3)' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    border: 'none',
    borderRadius: '6px',
    color: '#000',
    fontSize: '13px',
    fontWeight: 'bold',
    cursor: loading ? 'not-allowed' : 'pointer',
    transition: 'all 0.2s ease'
  };

  const linkStyle = {
    color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    background: 'none',
    border: 'none',
    fontSize: '12px',
    cursor: 'pointer',
    textDecoration: 'underline',
    padding: 0
  };

  return (
    <div style={{
      padding: '20px',
      background: 'rgba(0, 0, 0, 0.3)',
      borderRadius: '8px',
      border: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.3)`
    }}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="enter username"
            style={inputStyle}
            disabled={loading}
            autoFocus
            autoComplete="username"
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="enter password"
            style={inputStyle}
            disabled={loading}
            autoComplete="current-password"
          />
        </div>

        {!isLogin && (
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>confirm password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="confirm password"
              style={inputStyle}
              disabled={loading}
              autoComplete="new-password"
            />
          </div>
        )}

        {error && (
          <div style={{
            color: '#ff4444',
            fontSize: '12px',
            padding: '8px',
            background: 'rgba(255, 68, 68, 0.1)',
            borderRadius: '4px',
            marginBottom: '12px'
          }}>
            {error}
          </div>
        )}

        {success && (
          <div style={{
            color: '#00ff88',
            fontSize: '12px',
            padding: '8px',
            background: 'rgba(0, 255, 136, 0.1)',
            borderRadius: '4px',
            marginBottom: '12px'
          }}>
            {success}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !username || !password || (!isLogin && password !== confirmPassword)}
          style={{
            ...buttonStyle,
            opacity: (loading || !username || !password || (!isLogin && password !== confirmPassword)) ? 0.5 : 1
          }}
        >
          {loading ? (isLogin ? 'signing in...' : 'creating account...') : (isLogin ? 'login' : 'create account')}
        </button>
      </form>

      <div style={{
        textAlign: 'center',
        marginTop: '14px',
        paddingTop: '14px',
        borderTop: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`,
        fontSize: '12px',
        color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
      }}>
        {isLogin ? "don't have an account? " : "already have an account? "}
        <button
          type="button"
          onClick={() => {
            setIsLogin(!isLogin);
            setError('');
            setSuccess('');
          }}
          style={linkStyle}
        >
          {isLogin ? 'register' : 'login'}
        </button>
      </div>
    </div>
  );
}
