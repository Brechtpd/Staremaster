import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Failed to find the root element');
}

const app = <App />;

if (process.env.NODE_ENV === 'development') {
  ReactDOM.createRoot(root).render(app);
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      {app}
    </React.StrictMode>
  );
}
