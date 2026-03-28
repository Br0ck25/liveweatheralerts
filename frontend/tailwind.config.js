/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  safelist: [
    {
      pattern:
        /^(text|bg|border|ring)-(sky|purple|emerald|amber|rose|teal)-(300|400|500)$/,
      variants: ['hover'],
    },
    'bg-sky-500/20', 'bg-purple-500/20', 'bg-emerald-500/20', 'bg-amber-500/20', 'bg-rose-500/20', 'bg-teal-500/20',
    'bg-sky-400/10', 'bg-purple-400/10', 'bg-emerald-400/10', 'bg-amber-400/10', 'bg-rose-400/10', 'bg-teal-400/10',
    'border-sky-400/20', 'border-purple-400/20', 'border-emerald-400/20', 'border-amber-400/20', 'border-rose-400/20', 'border-teal-400/20',
    'border-sky-300/10', 'border-purple-300/10', 'border-emerald-300/10', 'border-amber-300/10', 'border-rose-300/10', 'border-teal-300/10',
    'ring-sky-400/70', 'ring-purple-400/70', 'ring-emerald-400/70', 'ring-amber-400/70', 'ring-rose-400/70', 'ring-teal-400/70',
    'hover:border-sky-500/40', 'hover:border-purple-500/40', 'hover:border-emerald-500/40', 'hover:border-amber-500/40', 'hover:border-rose-500/40', 'hover:border-teal-500/40',
    'border-sky-500/20', 'border-purple-500/20', 'border-emerald-500/20', 'border-amber-500/20', 'border-rose-500/20', 'border-teal-500/20',
    'bg-sky-950/60', 'bg-purple-950/60', 'bg-emerald-950/60', 'bg-amber-950/60', 'bg-rose-950/60', 'bg-teal-950/60',
  ],
  plugins: [],
}
