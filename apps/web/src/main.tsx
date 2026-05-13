import { isCrossOriginIsolationAvailable } from './lib/cross-origin-isolation';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

if (!isCrossOriginIsolationAvailable()) {
  void import('./components/Errors/CrossOriginIsolationRequired').then(
    ({ renderStandalone }) => {
      renderStandalone(container);
    },
  );
} else {
  void import('./boot-app').then(({ mountApp }) => {
    mountApp(container);
  });
}
