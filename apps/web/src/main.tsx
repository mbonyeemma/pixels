import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './ui/ErrorBoundary';
import { loadQuality } from './ui/QualityToggle';
import { useGame } from './state';
import './styles.css';
import './ui/hud.css';

useGame.setState({ quality: loadQuality() });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
