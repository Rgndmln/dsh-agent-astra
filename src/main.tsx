import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ensureSpatialStyles } from './styles';

document.documentElement.classList.add('spatial-standalone-host');
ensureSpatialStyles();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
