import CopyCommandBlock from '../components/CopyCommandBlock';

const REGISTRY_URL = 'https://artifact-keeper.qtsolvdev.com/npm/qa-automation-libraries/';
const REGISTRY_HOST_PATH = '//artifact-keeper.qtsolvdev.com/npm/qa-automation-libraries/';

function StepNumber({ n }) {
  return (
    <span style={{
      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
      background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 13,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {n}
    </span>
  );
}

function Step({ n, title, children }) {
  return (
    <div style={{ display: 'flex', gap: 14, padding: '20px 0', borderBottom: '1px solid var(--color-border-secondary)' }}>
      <StepNumber n={n} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export default function Recorder({ onAppNav }) {
  return (
    <div className="page fade-in">
      <div className="card" style={{ marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 4 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: 'var(--color-background-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <i className="ti ti-device-mobile" style={{ fontSize: 18, color: 'var(--accent)' }} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Peako Recorder Setup</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              Run the recorder locally to capture network traffic from your application and export.
            </div>
          </div>
        </div>

        <Step n={1} title="Get your registry token">
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            The recorder package is hosted on a private registry. Open your profile to copy your registry token.
          </div>
          <button
            onClick={() => onAppNav?.('profile')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)',
              color: 'var(--accent)', borderRadius: 20, padding: '9px 18px',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <i className="ti ti-user" style={{ fontSize: 14 }} /> Open Profile → Registry Token
          </button>
        </Step>

        <Step n={2} title="Configure the private registry">
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            Run these two commands once in your terminal — replace <code>&lt;YOUR_TOKEN&gt;</code> with the token copied from your profile:
          </div>
          <CopyCommandBlock command={`npm config set @peako:registry ${REGISTRY_URL}`} />
          <CopyCommandBlock command={`npm config set "${REGISTRY_HOST_PATH}:_authToken" "<YOUR_TOKEN>"`} />
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            <i className="ti ti-info-circle" style={{ marginRight: 4 }} />
            These settings are saved to your global <code>~/.npmrc</code> — you only need to run them once per machine.
          </div>
        </Step>

        <Step n={3} title="Install the recorder">
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            Install the recorder globally from the private registry:
          </div>
          <CopyCommandBlock command="npm install -g @peako/network-recorder" />
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            <i className="ti ti-info-circle" style={{ marginRight: 4 }} />
            Requires Node.js 18+ installed on your machine.
          </div>
        </Step>

        <div style={{ display: 'flex', gap: 14, padding: '20px 0 4px' }}>
          <StepNumber n={4} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Run the recorder</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
              Start the local recorder server. It will launch a browser window automatically:
            </div>
            <CopyCommandBlock command="npx @peako/network-recorder" />
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              <i className="ti ti-info-circle" style={{ marginRight: 4 }} />
              Keep this terminal open while recording. The recorder runs on http://localhost:9300 by default.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
