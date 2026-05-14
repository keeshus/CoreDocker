export const metadata = {
  title: 'Docker Manager',
  description: 'CoreDocker - Docker Container Management Platform',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
