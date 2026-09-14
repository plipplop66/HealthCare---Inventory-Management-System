import React, { useEffect, useState } from 'react';
import { motion, useAnimation, useInView } from 'framer-motion';

// Staggered variants for Grid children
export const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1
    }
  }
};

export const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } }
};

export const Card = ({ children, style, className }) => (
  <motion.div 
    variants={itemVariants}
    className={`glass ${className || ''}`}
    style={{ borderRadius: '16px', padding: '1.4rem 1.6rem', ...style }}
  >
    {children}
  </motion.div>
);

// Animated Counter Hook
function useAnimatedCounter(endValue, duration = 1.5) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / (duration * 1000), 1);
      
      // Easing out function
      const easeOutQuart = 1 - Math.pow(1 - progress, 4);
      setCount(easeOutQuart * endValue);
      
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }, [endValue, duration]);

  return count;
}

export const Stat = ({ label, value, sub }) => {
  // Extract number if value is a string like "2.8 days"
  const isNumber = typeof value === 'number';
  const numMatch = typeof value === 'string' ? value.match(/^([\d.]+)(.*)$/) : null;
  const numValue = isNumber ? value : (numMatch ? parseFloat(numMatch[1]) : null);
  const suffix = !isNumber && numMatch ? numMatch[2] : '';

  const animatedValue = useAnimatedCounter(numValue || 0);
  
  // Decide what to show
  const displayValue = numValue !== null ? 
    (Number.isInteger(numValue) ? Math.round(animatedValue) : animatedValue.toFixed(1)) + suffix 
    : value;

  return (
    <motion.div 
      variants={itemVariants}
      className="glass"
      style={{ borderRadius: '16px', padding: '1.2rem 1.4rem' }}
    >
      <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</p>
      <p style={{ fontSize: '28px', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>{displayValue}</p>
      {sub && <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '8px 0 0' }}>{sub}</p>}
    </motion.div>
  );
};

export const Grid = ({ children, cols = 4, gap = '16px' }) => (
  <motion.div 
    variants={containerVariants}
    initial="hidden"
    animate="show"
    style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap }}
  >
    {children}
  </motion.div>
);

export const Tag = ({ text, tone = 'secondary' }) => (
  <span style={{ fontSize: '10.5px', padding: '4px 12px', borderRadius: '12px', background: `var(--bg-${tone})`, color: `var(--text-${tone})`, whiteSpace: 'nowrap', border: `1px solid var(--border-${tone} || var(--bg-${tone}))` }}>
    {text}
  </span>
);

export const DotState = ({ label, tone }) => (
  <span style={{ fontSize: '11.5px', color: `var(--text-${tone})`, display: 'flex', alignItems: 'center', gap: '6px' }}>
    <span style={{ fontSize: '10px', filter: `drop-shadow(0 0 4px var(--text-${tone}))` }}>●</span> {label}
  </span>
);

export const Eyebrow = ({ text }) => (
  <p style={{ fontSize: '11px', letterSpacing: '1px', color: 'var(--primary-brand)', fontWeight: 600, margin: '0 0 8px' }}>
    {text.toUpperCase()}
  </p>
);

export const PageHead = ({ eyeb, title, sub, rightHtml }) => (
  <motion.div 
    initial={{ opacity: 0, y: -20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.4, ease: "easeOut" }}
    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}
  >
    <div>
      <Eyebrow text={eyeb} />
      <h1 style={{ fontSize: '32px', fontWeight: 600, margin: '0 0 8px', letterSpacing: '-0.5px' }}>{title}</h1>
      {sub && <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: 0 }}>{sub}</p>}
    </div>
    {rightHtml}
  </motion.div>
);

export const Button = ({ children, primary, onClick, style, disabled }) => (
  <motion.button 
    whileHover={{ scale: disabled ? 1 : 1.05, boxShadow: primary ? '0 0 15px rgba(56, 189, 248, 0.4)' : '0 0 10px rgba(255,255,255,0.1)' }}
    whileTap={{ scale: disabled ? 1 : 0.95 }}
    onClick={onClick}
    disabled={disabled}
    style={{
      background: primary ? 'var(--primary-brand)' : 'rgba(255,255,255,0.05)',
      color: primary ? '#0B1120' : 'var(--text-primary)',
      border: primary ? 'none' : '1px solid var(--border)',
      padding: '10px 20px',
      borderRadius: '10px',
      fontSize: '13px',
      fontWeight: 500,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background 0.2s, border 0.2s',
      ...style
    }}
  >
    {children}
  </motion.button>
);

export const DarkBanner = ({ children }) => (
  <motion.div 
    initial={{ opacity: 0, scale: 0.95 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ duration: 0.3 }}
    className="glass"
    style={{ background: 'rgba(30, 41, 59, 0.8)', padding: '1.4rem 1.6rem' }}
  >
    {children}
  </motion.div>
);

// Page transition wrapper
export const PageTransition = ({ children }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -20 }}
    transition={{ duration: 0.3, ease: 'easeOut' }}
  >
    {children}
  </motion.div>
);
