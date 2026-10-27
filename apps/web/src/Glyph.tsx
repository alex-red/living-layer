export function Glyph({ type = 'layers' }: { type?: 'layers' | 'arrow' | 'camera' | 'upload' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {type === 'layers' ? (
        <>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </>
      ) : type === 'arrow' ? (
        <path d="M4 12h16m-6-6 6 6-6 6" />
      ) : type === 'camera' ? (
        <>
          <path d="M3 7h4l2-3h6l2 3h4v13H3Z" />
          <circle cx="12" cy="13" r="4" />
        </>
      ) : (
        <>
          <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
        </>
      )}
    </svg>
  );
}
