import { Navigate, Route, Routes } from 'react-router-dom';
import { ApiKeyProvider } from './context/ApiKeyContext.jsx';
import { WkImageProvider } from './context/WkImageContext.jsx';
import PortalLayout from './components/PortalLayout.jsx';
import WelcomePage from './pages/WelcomePage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import { tools } from './tools.js';

export default function App() {
  return (
    <ApiKeyProvider>
      <WkImageProvider>
        <Routes>
          <Route path="/" element={<PortalLayout />}>
            <Route index element={<WelcomePage />} />
            {tools.map((tool) => (
              <Route key={tool.path} path={tool.path.replace(/^\//, '')} element={<tool.component />} />
            ))}
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </WkImageProvider>
    </ApiKeyProvider>
  );
}
