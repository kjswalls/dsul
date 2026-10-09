export const useTheme = () => ({
  theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  resolvedTheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  setTheme() {},
  themes: ['light', 'dark'],
});
export const ThemeProvider = ({ children }: { children: React.ReactNode }) => children;
