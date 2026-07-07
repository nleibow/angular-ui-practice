import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Note: no StrictMode — its dev double-mount would open two WebSockets / peer
// connections. The app manages long-lived connections imperatively.
createRoot(document.getElementById('root')!).render(<App />);
