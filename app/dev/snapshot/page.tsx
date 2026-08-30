import SnapshotGenerator from './SnapshotGenerator';

export default function SnapshotPage() {
  if (process.env.NODE_ENV === 'production') {
    return <main style={{ padding: 32, fontFamily: 'ui-sans-serif, system-ui' }}>Not available in production builds.</main>;
  }
  return <SnapshotGenerator />;
}
