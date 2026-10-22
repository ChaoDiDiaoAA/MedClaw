const paths = {
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  data: 'M4 4h16v16H4z M4 10h16 M10 4v16',
  history: 'M3 11a9 9 0 1 1 2.6 7 M3 4v7h7 M12 7v5l3 2',
  models: 'm12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5',
  prompt: 'm5 5 6 7-6 7 M13 19h6',
  skills: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z',
  extensions: 'M9 3h6v5h5v6h-5v6H9v-6H3V8h6V3Z',
  evaluation: 'M5 3h14v18H5z M8 8l1 1 2-2 M13 8h3 M8 14l1 1 2-2 M13 14h3',
  settings: 'm9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 3 2 3-2 1-3 3-1v-4l-3-1-1-3-4-1ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  panel: 'M3 4h18v16H3z M15 4v16',
  chevron: 'm14 6-6 6 6 6',
  plus: 'M12 5v14 M5 12h14',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5',
  moon: 'M20.8 13a9 9 0 0 1-9.8-9.8A9 9 0 1 0 20.8 13Z',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M4 21v-2a8 8 0 0 1 16 0v2',
  assistant: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
