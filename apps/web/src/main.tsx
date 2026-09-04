import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Building2,
  Droplets,
  LogOut,
  Radio,
  RefreshCw,
  ShieldAlert,
  Waves
} from 'lucide-react';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

type Summary = {
  condominiums: number;
  units: number;
  sensors: number;
  sensors_online: number;
  sensors_offline: number;
  month_consumption_m3: number;
  today_consumption_m3: number;
};

type Sensor = {
  id: string;
  serial: string;
  sensor_type: string;
  last_raw_value: number | null;
  last_reading_at: string | null;
  virtual_counter: number;
  unit_identifier: string | null;
  building_name: string | null;
  condominium_name: string | null;
  connection_status: 'online' | 'attention' | 'offline';
};

type LoginResponse = {
  token: string;
  user: { name: string; email: string; role: string };
};

function api(path: string, token?: string, init?: RequestInit) {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    }
  });
}

function Login({ onLogin }: { onLogin: (data: LoginResponse) => void }) {
  const [email, setEmail] = useState('admin@hidrocondo.local');
  const [password, setPassword] = useState('HidroCondo@2026');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await api('/api/v1/auth/login', undefined, {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Falha no login');
      onLogin(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-hero">
        <div className="brand-mark"><Waves size={32} /></div>
        <p className="eyebrow">MONITORAMENTO INTELIGENTE DE ÁGUA</p>
        <h1>HidroCondo</h1>
        <p className="login-copy">
          Consumo, telemetria e alertas de todos os seus condomínios em um único lugar.
        </p>
      </section>
      <form className="login-card" onSubmit={submit}>
        <div>
          <p className="eyebrow">ACESSO AO PAINEL</p>
          <h2>Bem-vindo</h2>
          <p className="muted">Entre com seu usuário para acompanhar as unidades.</p>
        </div>
        <label>E-mail<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" /></label>
        <label>Senha<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" /></label>
        {error && <div className="error-box">{error}</div>}
        <button disabled={loading}>{loading ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </main>
  );
}

function Dashboard({ session, onLogout }: { session: LoginResponse; onLogout: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [summaryResponse, sensorResponse] = await Promise.all([
        api('/api/v1/dashboard/summary', session.token),
        api('/api/v1/sensores', session.token)
      ]);
      if (summaryResponse.status === 401 || sensorResponse.status === 401) return onLogout();
      if (!summaryResponse.ok || !sensorResponse.ok) throw new Error('Falha ao carregar o painel');
      setSummary(await summaryResponse.json());
      setSensors(await sensorResponse.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar o painel');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const unassigned = useMemo(() => sensors.filter((sensor) => !sensor.unit_identifier).length, [sensors]);
  const number = (value: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(value ?? 0);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark small"><Waves size={22} /></div><span>HidroCondo</span></div>
        <nav>
          <a className="active"><Activity size={18} />Visão geral</a>
          <a><Building2 size={18} />Condomínios</a>
          <a><Droplets size={18} />Unidades</a>
          <a><Radio size={18} />Sensores</a>
          <a><ShieldAlert size={18} />Alertas</a>
        </nav>
        <div className="sidebar-footer">
          <div><strong>{session.user.name}</strong><span>{session.user.role}</span></div>
          <button className="icon-button" onClick={onLogout} title="Sair"><LogOut size={18} /></button>
        </div>
      </aside>

      <main className="content">
        <header className="page-header">
          <div><p className="eyebrow">PAINEL OPERACIONAL</p><h1>Visão geral</h1><p className="muted">Acompanhamento de consumo e comunicação dos sensores.</p></div>
          <button className="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Atualizar</button>
        </header>

        {error && <div className="error-box">{error}</div>}

        <section className="metric-grid">
          <article className="metric-card"><div className="metric-icon"><Droplets size={20} /></div><span>Consumo no mês</span><strong>{number(summary?.month_consumption_m3 ?? 0)} m³</strong><small>acumulado no período atual</small></article>
          <article className="metric-card"><div className="metric-icon"><Activity size={20} /></div><span>Consumo hoje</span><strong>{number(summary?.today_consumption_m3 ?? 0)} m³</strong><small>desde 00:00</small></article>
          <article className="metric-card"><div className="metric-icon"><Radio size={20} /></div><span>Sensores online</span><strong>{summary?.sensors_online ?? 0}/{summary?.sensors ?? 0}</strong><small>{summary?.sensors_offline ?? 0} offline</small></article>
          <article className="metric-card"><div className="metric-icon"><Building2 size={20} /></div><span>Estrutura</span><strong>{summary?.condominiums ?? 0} condomínios</strong><small>{summary?.units ?? 0} unidades monitoradas</small></article>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">TELEMETRIA</p><h2>Sensores</h2></div>
            <span className="muted">{unassigned} ainda sem unidade vinculada</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Sensor</th><th>Condomínio</th><th>Unidade</th><th>Leitura</th><th>Última comunicação</th><th>Status</th></tr></thead>
              <tbody>
                {sensors.map((sensor) => (
                  <tr key={sensor.id}>
                    <td><strong>{sensor.serial}</strong><span className="cell-sub">Tipo {sensor.sensor_type}</span></td>
                    <td>{sensor.condominium_name ?? 'Não vinculado'}<span className="cell-sub">{sensor.building_name ?? '—'}</span></td>
                    <td>{sensor.unit_identifier ?? '—'}</td>
                    <td>{sensor.last_raw_value == null ? '—' : String(sensor.last_raw_value).padStart(3, '0')}</td>
                    <td>{sensor.last_reading_at ? new Date(sensor.last_reading_at).toLocaleString('pt-BR') : 'Nunca'}</td>
                    <td><span className={`status ${sensor.connection_status}`}>{sensor.connection_status}</span></td>
                  </tr>
                ))}
                {!loading && sensors.length === 0 && <tr><td colSpan={6} className="empty">Nenhum sensor recebido ainda.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<LoginResponse | null>(() => {
    const raw = localStorage.getItem('hidrocondo.session');
    return raw ? JSON.parse(raw) : null;
  });

  function login(data: LoginResponse) {
    localStorage.setItem('hidrocondo.session', JSON.stringify(data));
    setSession(data);
  }

  function logout() {
    localStorage.removeItem('hidrocondo.session');
    setSession(null);
  }

  return session ? <Dashboard session={session} onLogout={logout} /> : <Login onLogin={login} />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
