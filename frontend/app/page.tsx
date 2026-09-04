'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import './landing.css';

function LandingInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Redirect old customer links (/?phone=...) to /apply
  useEffect(() => {
    const phone = searchParams.get('phone');
    if (phone) router.replace(`/apply?phone=${encodeURIComponent(phone)}`);
  }, [searchParams, router]);

  useEffect(() => {
    const prefRM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ── Particle canvas ── */
    const canvas = document.getElementById('particles') as HTMLCanvasElement | null;
    let rafId = 0;
    let resTO: ReturnType<typeof setTimeout>;

    if (canvas) {
      const c = canvas; // capture non-null for closures
      const ctx = c.getContext('2d')!;
      const PCOUNT = 55, MAX_DIST = 130;

      class Particle {
        x: number; y: number; vx: number; vy: number; r: number;
        constructor() {
          this.x  = Math.random() * c.width;
          this.y  = Math.random() * c.height;
          this.vx = (Math.random() - 0.5) * 0.32;
          this.vy = (Math.random() - 0.5) * 0.32;
          this.r  = Math.random() * 1.4 + 0.4;
        }
        update() {
          this.x += this.vx; this.y += this.vy;
          if (this.x < 0 || this.x > c.width)  this.vx *= -1;
          if (this.y < 0 || this.y > c.height)  this.vy *= -1;
        }
        draw() {
          ctx.beginPath();
          ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(37,99,235,0.45)';
          ctx.fill();
        }
      }

      const particles: Particle[] = [];

      function resizeCanvas() {
        const hero = document.getElementById('hero');
        if (!hero) return;
        c.width  = hero.offsetWidth;
        c.height = hero.offsetHeight;
      }

      function drawLines() {
        for (let i = 0; i < particles.length; i++) {
          for (let j = i + 1; j < particles.length; j++) {
            const dx = particles[i].x - particles[j].x;
            const dy = particles[i].y - particles[j].y;
            const d  = Math.sqrt(dx * dx + dy * dy);
            if (d < MAX_DIST) {
              const a = (1 - d / MAX_DIST) * 0.18;
              ctx.beginPath();
              ctx.moveTo(particles[i].x, particles[i].y);
              ctx.lineTo(particles[j].x, particles[j].y);
              ctx.strokeStyle = `rgba(37,99,235,${a})`;
              ctx.lineWidth = 0.6;
              ctx.stroke();
            }
          }
        }
      }

      function tick() {
        ctx.clearRect(0, 0, c.width, c.height);
        particles.forEach(p => { p.update(); p.draw(); });
        drawLines();
        rafId = requestAnimationFrame(tick);
      }

      for (let i = 0; i < PCOUNT; i++) particles.push(new Particle());
      resizeCanvas();
      if (prefRM) { particles.forEach(p => p.draw()); } else { tick(); }

      const handleResize = () => {
        clearTimeout(resTO);
        resTO = setTimeout(resizeCanvas, 120);
      };
      window.addEventListener('resize', handleResize);
    }

    /* ── Scroll reveal ── */
    const rvEls = document.querySelectorAll<HTMLElement>('.rv');
    if (prefRM) {
      rvEls.forEach(el => el.classList.add('in'));
    } else {
      const io = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });
      rvEls.forEach(el => io.observe(el));
    }

    /* ── Stat counters ── */
    function countUp(el: HTMLElement, to: number) {
      if (prefRM) { el.textContent = String(to); return; }
      let start: number | null = null;
      (function step(ts: number) {
        if (!start) start = ts;
        const p = Math.min((ts - start) / 1200, 1);
        el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
      })(performance.now());
    }
    const statIO = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.querySelectorAll<HTMLElement>('[data-count]').forEach(el => {
          countUp(el, parseInt(el.dataset.count ?? '0', 10));
        });
        statIO.unobserve(e.target);
      });
    }, { threshold: 0.5 });
    document.querySelectorAll('.stat-cell').forEach(el => statIO.observe(el));

    /* ── Nav on scroll ── */
    const nav = document.getElementById('nav');
    const handleScroll = () => {
      nav?.classList.toggle('scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });

    /* ── Theme toggle ── */
    const themeBtn = document.getElementById('themeToggle');
    const handleTheme = () => {
      const root = document.documentElement;
      const cur = root.getAttribute('data-theme');
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const isDark = cur === 'dark' || (!cur && sysDark);
      const next = isDark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      root.style.colorScheme = next;
      try { localStorage.setItem('finix.theme', next); } catch (_) {}
    };
    themeBtn?.addEventListener('click', handleTheme);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(resTO);
      window.removeEventListener('scroll', handleScroll);
      themeBtn?.removeEventListener('click', handleTheme);
    };
  }, []);

  return (
    <div className="lp">
      {/* ── NAV ── */}
      <nav id="nav">
        <div className="nav-inner">
          <a className="nav-logo" href="#hero">
            <img className="logo-mark-dark" src="/brand/finix-mark-dark.png" width="43" height="48" alt="" aria-hidden={true} />
            <img className="logo-mark-light" src="/brand/finix-mark.png" width="43" height="48" alt="" aria-hidden={true} />
            Finix
          </a>
          <ul className="nav-links">
            <li><a href="#features">Capabilities</a></li>
            <li><a href="#flow">How It Works</a></li>
            <li><a href="#portals">Portals</a></li>
            <li><a href="#compliance">Security</a></li>
          </ul>
          <div className="nav-right">
            <button className="btn-theme" id="themeToggle" aria-label="Toggle theme">
              <svg className="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
              <svg className="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
              </svg>
            </button>
            <a className="btn-nav" href="#portals">
              Get Started
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="3" y1="8" x2="13" y2="8"/><polyline points="9,4 13,8 9,12"/>
              </svg>
            </a>
          </div>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section id="hero">
        <canvas id="particles" aria-hidden="true"></canvas>
        <div className="aurora aurora-1" aria-hidden="true"></div>
        <div className="aurora aurora-2" aria-hidden="true"></div>
        <div className="aurora aurora-3" aria-hidden="true"></div>
        <div className="wrap">
          <div className="hero-grid">
            <div>
              <div className="hero-tl" role="doc-subtitle">
                <span className="htw" style={{'--i': 0} as React.CSSProperties}><span className="htw-t">Connect</span><span className="htw-u" aria-hidden="true"></span></span>
                <span className="htsep" style={{'--d': '.38s'} as React.CSSProperties} aria-hidden="true"></span>
                <span className="htw" style={{'--i': 1} as React.CSSProperties}><span className="htw-t">Score</span><span className="htw-u" aria-hidden="true"></span></span>
                <span className="htsep" style={{'--d': '.66s'} as React.CSSProperties} aria-hidden="true"></span>
                <span className="htw" style={{'--i': 2} as React.CSSProperties}><span className="htw-t">Approve</span><span className="htw-u" aria-hidden="true"></span></span>
              </div>
              <h1 className="hero-h1">
                <span className="line"><span className="li">Smart lending,</span></span>
                <span className="line"><span className="li grad-text">from call to</span></span>
                <span className="line"><span className="li grad-text-b">approval.</span></span>
              </h1>
              <p className="hero-sub">
                Finix orchestrates your entire lending pipeline — AI voice agents qualify leads,
                instant KYC verifies identity, and the risk scorecard scores every application.
                Your officers focus on decisions, not process.
              </p>
              <div className="hero-btns">
                <a className="btn-primary" href="#portals">
                  Explore Platform
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="3" y1="8" x2="13" y2="8"/><polyline points="9,4 13,8 9,12"/>
                  </svg>
                </a>
                <a className="btn-outline" href="#flow">How It Works</a>
              </div>
              {/* Names, not acronyms. BUCB / SFB / NRCB in mono-font chips
                  read as unfilled placeholders — an acronym a visitor does not
                  recognise proves nothing, and the empty boxes made it look
                  unfinished. */}
              <div className="trusted">
                <span className="lbl">Trusted by</span>
                <p className="trusted-names">
                  Buldhana Urban Co-op Bank<span className="trusted-sep">·</span>
                  State Finance Bank<span className="trusted-sep">·</span>
                  National Rural Credit Bank
                </p>
              </div>
            </div>
            <div className="card-scene">
              <div className="card-wrap">
                <div className="card">
                  <div className="card-chip"></div>
                  <div className="card-num">4729 &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; 8341</div>
                  <div className="card-foot">
                    <div>
                      <div className="card-name">VGIL FINIX</div>
                      <div className="card-exp">EXP &nbsp;12 / 28</div>
                    </div>
                    <div className="mc"><span></span><span></span></div>
                  </div>
                </div>
                <div className="fchip fchip-a">
                  <div className="fchip-icon fi-blue">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <div>
                    <div className="fchip-lbl">Loan Approved</div>
                    <div className="fchip-val">₹ 5,00,000</div>
                  </div>
                </div>
                <div className="fchip fchip-b">
                  <div className="fchip-icon fi-cyan">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  </div>
                  <div>
                    <div className="fchip-lbl">KYC Verified</div>
                    <div className="fchip-val-sm">PAN + Aadhaar</div>
                  </div>
                </div>
                <div className="fchip fchip-c">
                  <span className="big">82</span>
                  <span className="lbl">Risk Score</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── STATS ── */}
      <section id="stats">
        <div className="stats-row wrap" style={{padding: 0}}>
          <div className="stat-cell rv" data-d="1">
            <span className="stat-n"><span className="hl">{'<'}</span>{' '}<span data-count={24}>24</span>h</span>
            <span className="stat-l">Loan Decision Time</span>
          </div>
          <div className="stat-cell rv" data-d="2">
            <span className="stat-n"><span className="hl" data-count={5}>5</span>+ Banks</span>
            <span className="stat-l">Active Tenants</span>
          </div>
          <div className="stat-cell rv" data-d="3">
            <span className="stat-n"><span className="hl" data-count={100}>100</span>%</span>
            <span className="stat-l">Digital KYC, Zero Paper</span>
          </div>
          <div className="stat-cell rv" data-d="4">
            <span className="stat-n"><span className="hl" data-count={5}>5</span> Portals</span>
            <span className="stat-l">Purpose-Built Interfaces</span>
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="section" id="features">
        <div className="wrap">
          <div className="centered rv">
            <h2 className="sec-h2">Everything your lending team needs,<br/>in <span className="grad-text">one platform.</span></h2>
            <p className="sec-sub">From first AI outbound call to approved disbursal — Finix handles every step without external tools or manual handoffs between teams.</p>
          </div>
          <div className="feat-grid">
            <div className="feat-card rv" data-d="1">
              <div className="feat-icon fi-a"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2C8 21 3 13.5 3 7a2 2 0 012-3z"/></svg></div>
              <h3>AI Outbound Calling</h3>
              <p>LiveKit voice agents call customers automatically, qualify leads in natural conversation, and hand off to officers. TRAI windows enforced at the platform layer.</p>
            </div>
            <div className="feat-card rv" data-d="2">
              <div className="feat-icon fi-c"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9,12 11,14 15,10"/></svg></div>
              <h3>Instant KYC Verification</h3>
              <p>PAN verified via VG DocVerify — name and DOB extracted and auto-filled. Aadhaar authenticated via DigiLocker. Both locked with timestamps the moment they pass.</p>
            </div>
            <div className="feat-card rv" data-d="3">
              <div className="feat-icon fi-b"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="9" width="8" height="12" rx="1"/><rect x="13" y="4" width="8" height="17" rx="1"/></svg></div>
              <h3>Multi-Bank Architecture</h3>
              <p>Each bank is an isolated tenant with its own seat cap, minute quota, and settings. VGIL controls platform-wide parameters; bank admins configure their workspace.</p>
            </div>
            <div className="feat-card rv" data-d="4">
              <div className="feat-icon fi-a"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg></div>
              <h3>Real-Time Operations</h3>
              <p>Server-Sent Events push live call status, AI transcripts, and application events to your ops dashboard instantly — no refresh, no polling, always current.</p>
            </div>
            <div className="feat-card rv" data-d="5">
              <div className="feat-icon fi-b"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg></div>
              <h3>Loan Risk Scorecard</h3>
              <p>Five-pillar weighted engine with configurable parameters, bands, and thresholds. Edit weights and all pending applications auto-rescore immediately — no code changes.</p>
            </div>
            <div className="feat-card rv" data-d="6">
              <div className="feat-icon fi-c"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></div>
              <h3>WhatsApp Integration</h3>
              <p>AiSensy delivers OTP messages, loan form links, and status updates over WhatsApp. Customers apply without visiting a branch — just a link on their phone.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FLOW ── */}
      <section className="section section-alt" id="flow">
        <div className="wrap">
          <div className="centered rv">
            <h2 className="sec-h2">Five stages. <span className="grad-text">Zero handoffs.</span></h2>
            <p className="sec-sub">Every loan moves through the complete pipeline inside Finix — from AI call to disbursal, nothing leaves the platform.</p>
          </div>
          <div className="flow-outer rv">
            <div className="flow-grid">
              <div className="flow-step">
                <div className="flow-ring"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2C8 21 3 13.5 3 7a2 2 0 012-3z"/></svg></div>
                <h3>AI Outbound Call</h3>
                <p>Agent contacts lead, qualifies intent, collects consent.</p>
              </div>
              <div className="flow-step">
                <div className="flow-ring"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="12" y2="13"/></svg></div>
                <h3>Customer Fills Form</h3>
                <p>WhatsApp link delivers the form. AI call data auto-fills fields.</p>
              </div>
              <div className="flow-step">
                <div className="flow-ring"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
                <h3>KYC &amp; Verify</h3>
                <p>PAN + Aadhaar verified instantly. Name, DOB auto-fill and lock.</p>
              </div>
              <div className="flow-step">
                <div className="flow-ring"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg></div>
                <h3>Risk Scorecard</h3>
                <p>LRS scores five pillars. Auto-approve above threshold.</p>
              </div>
              <div className="flow-step">
                <div className="flow-ring"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <h3>Officer Approval</h3>
                <p>Officer reviews, decides. High-value needs a second approver.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── PORTALS ── */}
      <section className="section" id="portals">
        <div className="wrap">
          <div className="rv">
            <h2 className="sec-h2">Every role, its own <span className="grad-text-b">workspace.</span></h2>
            <p className="sec-sub">Five purpose-built portals sharing the same data and live event stream underneath.</p>
          </div>
          <div className="portals-grid">
            <div className="portal-card rv" data-d="1">
              <span className="portal-role pr-admin">VGIL Administration</span>
              <h3>System Admin Console</h3>
              <p>Platform-level control for the Virtual Galaxy team. Onboard banks, configure seat caps and minute quotas, manage global users, monitor system-wide activity.</p>
              <ul className="portal-feats">
                <li>Bank onboarding &amp; tenant config</li>
                <li>Seat cap &amp; minute quota management</li>
                <li>Global user administration</li>
                <li>Platform-wide call logs</li>
              </ul>
            </div>
            <div className="portal-card rv" data-d="2">
              <span className="portal-role pr-bank">Bank Administration</span>
              <h3>Bank Admin Portal</h3>
              <p>Self-service control per bank. Invite officers, review usage and minutes, configure calling windows, set workflow rules — no VGIL contact needed.</p>
              <ul className="portal-feats">
                <li>User invite &amp; role management</li>
                <li>Call usage &amp; minute analytics</li>
                <li>Calling window configuration</li>
                <li>Maker-checker threshold settings</li>
              </ul>
            </div>
            <div className="portal-card rv" data-d="3">
              <span className="portal-role pr-off">Loan Officer</span>
              <h3>Bank Officer Portal</h3>
              <p>Daily workspace for officers reviewing applications. LRS scorecard view, KYC status, batch calling, and one-click approve / refer / reject.</p>
              <ul className="portal-feats">
                <li>Application queue &amp; scorecard</li>
                <li>KYC &amp; document review</li>
                <li>Batch outbound calling</li>
                <li>Approve, refer, or reject</li>
              </ul>
            </div>
            <div className="portal-card rv" data-d="4">
              <span className="portal-role pr-ops">Operations Team</span>
              <h3>Operations Console</h3>
              <p>Real-time command centre. SSE pushes live call status, AI transcripts, and application events the instant they happen — no manual refresh required.</p>
              <ul className="portal-feats">
                <li>Live call monitoring (SSE)</li>
                <li>AI transcript stream</li>
                <li>Agent concurrency view</li>
                <li>Retry &amp; escalation logs</li>
              </ul>
            </div>
            <div className="portal-card portal-span rv" data-d="5">
              <span className="portal-role pr-ops">Customer-Facing</span>
              <h3>Loan Application Form</h3>
              <p>Mobile-first multi-step form. PAN and Aadhaar KYC inline with auto-fill from verified data. No branch visit, no app install — just a WhatsApp link.</p>
              <ul className="portal-feats" style={{flexDirection:'row',flexWrap:'wrap',gap:'8px 36px',marginTop:'14px'}}>
                <li>PAN &amp; Aadhaar KYC inline</li>
                <li>Auto-fill from verified data</li>
                <li>Income &amp; employment details</li>
                <li>Document photo upload</li>
                <li>WhatsApp OTP verification</li>
                <li>Mobile-first, no app install</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── COMPLIANCE ── */}
      <section className="section section-alt" id="compliance">
        <div className="wrap">
          <div className="centered rv">
            <h2 className="sec-h2">Built for <span className="grad-text">India&#39;s lending</span> regulations.</h2>
            <p className="sec-sub">Regulatory requirements are enforced at the platform layer — your team doesn&#39;t have to think about them.</p>
          </div>
          <div className="comp-grid">
            <div className="comp-card rv" data-d="1">
              <div className="comp-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg></div>
              <h3>RBI &amp; TRAI Calling Windows</h3>
              <p>Configurable start and end times per bank. The AI agent stops automatically outside permitted hours. Pause-outbound toggles instantly from the admin portal.</p>
            </div>
            <div className="comp-card rv" data-d="2">
              <div className="comp-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
              <h3>Maker-Checker Workflow</h3>
              <p>Applications above a threshold require a second approver. Threshold, enforced-differ, and branch scoping are per-bank settings with no code changes required.</p>
            </div>
            <div className="comp-card rv" data-d="3">
              <div className="comp-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></div>
              <h3>Full Audit Trail</h3>
              <p>Every action — status change, role update, settings save, scorecard edit — written to an append-only log with actor, timestamp, and full before/after detail.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section id="cta">
        <div className="wrap">
          <div className="rv">
            <div className="cta-panel-wrap">
              <div className="cta-panel">
                <h2>Ready to transform your <span className="grad-text">lending pipeline?</span></h2>
                <p>See how Finix handles every step — AI call to final disbursal — in one platform built for your bank.</p>
                <div className="cta-btns">
                  <a className="btn-primary" href="#portals">
                    Explore the Platform
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="3" y1="8" x2="13" y2="8"/><polyline points="9,4 13,8 9,12"/>
                    </svg>
                  </a>
                  <a className="btn-outline" href="#compliance">Security &amp; Compliance</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── TECH STACK ── */}
      <section className="section" id="stack">
        <div className="wrap">
          <div className="rv">
            <h2 className="sec-h2">Production-grade stack,<br/>open-source foundations.</h2>
          </div>
          <div className="chips-row rv">
            <span className="chip chip-hi">Next.js 14</span>
            <span className="chip chip-hi">FastAPI</span>
            <span className="chip chip-hi">PostgreSQL</span>
            <span className="chip chip-hi">Python</span>
            <span className="chip chip-hi">TypeScript</span>
            <span className="chip">LiveKit</span>
            <span className="chip">AiSensy</span>
            <span className="chip">DigiLocker</span>
            <span className="chip">VG DocVerify</span>
            <span className="chip">asyncpg</span>
            <span className="chip">Server-Sent Events</span>
            <span className="chip">JWT Auth</span>
            <span className="chip">pgcrypto</span>
            <span className="chip">App Router</span>
            <span className="chip">Docker</span>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer>
        <div className="wrap">
          <div className="footer-top">
            <div className="footer-brand">
              <a className="footer-logo" href="#hero">
                <img className="logo-mark-dark" src="/brand/finix-mark-dark.png" width="37" height="41" alt="" aria-hidden={true} />
                <img className="logo-mark-light" src="/brand/finix-mark.png" width="37" height="41" alt="" aria-hidden={true} />
                Finix
              </a>
              <p className="footer-tagline">Connect. Score. Approve.</p>
              <p>AI-powered Loan Origination System by Virtual Galaxy IFINTECH Pvt. Ltd. Built for modern banks across India.</p>
            </div>
            <div className="footer-col">
              <h4>Platform</h4>
              <ul>
                <li><a href="#features">Capabilities</a></li>
                <li><a href="#flow">How It Works</a></li>
                <li><a href="#portals">Portals</a></li>
                <li><a href="#stack">Technology</a></li>
              </ul>
            </div>
            <div className="footer-col">
              <h4>Compliance</h4>
              <ul>
                <li><a href="#compliance">RBI &amp; TRAI</a></li>
                <li><a href="#compliance">Maker-Checker</a></li>
                <li><a href="#compliance">Audit Trail</a></li>
                <li><a href="#compliance">KYC &amp; Identity</a></li>
              </ul>
            </div>
          </div>
          <div className="footer-bottom">
            <span>© 2025 Virtual Galaxy IFINTECH Pvt. Ltd. · All rights reserved</span>
            <span>Finix v1 · Confidential &amp; Proprietary</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function LandingPage() {
  return (
    <Suspense>
      <LandingInner />
    </Suspense>
  );
}
