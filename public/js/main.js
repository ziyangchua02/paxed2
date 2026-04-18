const MIN_LOADER_DURATION_MS = 700;
const SOFT_COMPLETE_MS = 1800;
const HARD_COMPLETE_MS = 4000;
const FINISH_ANIMATION_MS = 140;
const LOADER_FADE_DURATION_MS = 320;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function setupScrollReveal() {
  document.body.classList.add("js-enhanced");

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  const sectionTargets = [
    ...document.querySelectorAll(
      ".how-it-works, .use-cases, .platform-section, .hardware-section, .pricing-section, .deploy-cta"
    )
  ];
  const revealTargets = [];

  const registerRevealGroup = (selectors, type, delayStep) => {
    selectors.forEach((selector, index) => {
      const element = document.querySelector(selector);

      if (!element) {
        return;
      }

      element.classList.add("scroll-reveal", type);
      element.style.setProperty("--reveal-delay", `${index * delayStep}ms`);
      revealTargets.push(element);
    });
  };

  const registerRevealCards = (selector, delayStep, cycleSize = 4) => {
    document.querySelectorAll(selector).forEach((element, index) => {
      element.classList.add("scroll-reveal", "scroll-reveal--card");
      element.style.setProperty(
        "--reveal-delay",
        `${(index % cycleSize) * delayStep}ms`
      );
      revealTargets.push(element);
    });
  };

  registerRevealGroup(
    [
      ".how-it-works__eyebrow",
      ".how-it-works__title",
      ".how-it-works__lead"
    ],
    "scroll-reveal--intro",
    90
  );
  registerRevealCards(".how-step-card", 70, 3);
  registerRevealGroup(
    [".use-cases__eyebrow", ".use-cases__title", ".use-cases__lead"],
    "scroll-reveal--intro",
    90
  );
  registerRevealCards(".use-case-card", 70, 2);
  registerRevealGroup(
    [
      ".platform-section__eyebrow",
      ".platform-section__title",
      ".platform-section__lead"
    ],
    "scroll-reveal--intro",
    90
  );
  registerRevealCards(".platform-card", 60, 4);
  registerRevealGroup(
    [
      ".hardware-section__eyebrow",
      ".hardware-section__title",
      ".hardware-section__lead"
    ],
    "scroll-reveal--intro",
    90
  );
  registerRevealCards(".hardware-card", 80, 2);
  registerRevealGroup(
    [
      ".pricing-section__eyebrow",
      ".pricing-section__title",
      ".pricing-section__lead"
    ],
    "scroll-reveal--intro",
    90
  );
  registerRevealCards(".pricing-card", 80, 2);
  registerRevealGroup(
    [
      ".deploy-cta__title",
      ".deploy-cta__lead",
      ".deploy-cta__actions",
      ".deploy-cta__meta"
    ],
    "scroll-reveal--intro",
    90
  );

  if (prefersReducedMotion) {
    sectionTargets.forEach((element) => element.classList.add("is-visible"));
    revealTargets.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    {
      threshold: 0.14,
      rootMargin: "0px 0px -10% 0px"
    }
  );

  const sectionObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    {
      threshold: 0.18
    }
  );

  sectionTargets.forEach((element) => sectionObserver.observe(element));
  revealTargets.forEach((element) => revealObserver.observe(element));
}

function setupScrollColorTransition() {
  const darkTrigger = document.querySelector("[data-dark-transition-trigger]");
  const purpleReturnTrigger = document.querySelector(
    "[data-purple-transition-trigger]"
  );

  if (!darkTrigger && !purpleReturnTrigger) {
    return;
  }

  const setShiftStrength = (strength) => {
    document.body.style.setProperty(
      "--section-shift-strength",
      strength.toFixed(3)
    );
  };

  const getProgress = (section, startFactor, endFactor) => {
    if (!section) {
      return 0;
    }

    const rect = section.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 1;
    const start = viewportHeight * startFactor;
    const end = viewportHeight * endFactor;

    return clamp01((start - rect.top) / (start - end));
  };

  let rafId = 0;

  const updateShift = () => {
    rafId = 0;

    const darkProgress = getProgress(darkTrigger, 0.98, 0.22);
    const purpleProgress = getProgress(purpleReturnTrigger, 0.62, -0.08);
    const shiftStrength = clamp01(darkProgress - purpleProgress);

    setShiftStrength(shiftStrength);
  };

  const requestUpdate = () => {
    if (rafId) {
      return;
    }

    rafId = window.requestAnimationFrame(updateShift);
  };

  requestUpdate();
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
}

function setupActiveNavSection() {
  const navLinks = [...document.querySelectorAll(".site-nav a[href^='#']")];

  if (!navLinks.length) {
    return;
  }

  const sections = navLinks
    .map((link) => {
      const targetId = link.getAttribute("href");
      const target = targetId ? document.querySelector(targetId) : null;

      if (!target) {
        return null;
      }

      return {
        link,
        target
      };
    })
    .filter(Boolean);

  if (!sections.length) {
    return;
  }

  const updateActiveLink = () => {
    const viewportHeight = window.innerHeight || 1;
    const focusLine = viewportHeight * 0.32;

    let activeItem = sections[0];

    sections.forEach((item) => {
      const rect = item.target.getBoundingClientRect();

      if (rect.top <= focusLine) {
        activeItem = item;
      }
    });

    sections.forEach((item) => {
      item.link.classList.toggle("is-active", item === activeItem);
    });
  };

  updateActiveLink();
  window.addEventListener("scroll", updateActiveLink, { passive: true });
  window.addEventListener("resize", updateActiveLink);
}

function runLoader() {
  if (!document.body) {
    return;
  }

  const loaderElement = document.querySelector(".page-loader");
  const percentElement = document.querySelector("[data-loader-percent]");
  const progressTrack = document.querySelector("[data-loader-track]");
  const progressBar = document.querySelector(".page-loader__bar");
  const startTime = performance.now();
  let loadSignaled = false;
  let loadSignaledAt = 0;
  let finalizeAt = 0;
  let postLoadStartPercent = 0;
  let percentValue = 0;
  let isFinalizing = false;
  let isFinished = false;
  let progressRafId = 0;
  let finishRafId = 0;
  let finalizeDelayTimerId = 0;
  let revealTimerId = 0;
  let softTimerId = 0;
  let hardTimerId = 0;

  const setPercent = (value) => {
    const clamped = Math.max(0, Math.min(100, value));
    const rounded = Math.round(clamped);

    if (clamped > percentValue) {
      percentValue = clamped;
    }

    if (percentElement) {
      percentElement.textContent = `${rounded}%`;
    }

    if (progressTrack) {
      progressTrack.setAttribute("aria-valuenow", String(rounded));
    }

    if (progressBar) {
      progressBar.style.transform = `scaleX(${(percentValue / 100).toFixed(4)})`;
    }

    if (loaderElement) {
      const stepped = Math.min(100, Math.round(percentValue / 5) * 5);
      loaderElement.setAttribute("data-progress-step", String(stepped));
    }
  };

  const clearTimers = () => {
    window.cancelAnimationFrame(progressRafId);
    window.cancelAnimationFrame(finishRafId);
    window.clearTimeout(finalizeDelayTimerId);
    window.clearTimeout(revealTimerId);
    window.clearTimeout(softTimerId);
    window.clearTimeout(hardTimerId);
  };

  const revealPage = () => {
    if (isFinished) {
      return;
    }

    isFinished = true;

    if (loaderElement) {
      loaderElement.classList.add("is-done");
    }

    revealTimerId = window.setTimeout(() => {
      document.body.classList.remove("is-loading");
      document.body.classList.add("page-ready");
    }, LOADER_FADE_DURATION_MS);
  };

  const animateToComplete = () => {
    const startPercent = percentValue;
    const startedAt = performance.now();

    const step = (now) => {
      if (isFinished) {
        return;
      }

      const elapsed = now - startedAt;
      const ratio = Math.min(1, elapsed / FINISH_ANIMATION_MS);
      const eased = 1 - Math.pow(1 - ratio, 3);
      const nextPercent = startPercent + (100 - startPercent) * eased;
      setPercent(nextPercent);

      if (ratio < 1) {
        finishRafId = window.requestAnimationFrame(step);
        return;
      }

      setPercent(100);
      revealPage();
    };

    finishRafId = window.requestAnimationFrame(step);
  };

  const finalize = () => {
    if (isFinalizing || isFinished) {
      return;
    }

    isFinalizing = true;
    clearTimers();
    animateToComplete();
  };

  const finalizeWhenAllowed = () => {
    const now = performance.now();

    if (!loadSignaled) {
      loadSignaled = true;
      loadSignaledAt = now;
      postLoadStartPercent = percentValue;
    }

    const elapsed = now - startTime;
    const wait = Math.max(0, MIN_LOADER_DURATION_MS - elapsed);
    finalizeAt = now + wait;
    window.clearTimeout(finalizeDelayTimerId);
    finalizeDelayTimerId = window.setTimeout(finalize, wait);
  };

  const tick = () => {
    if (isFinished || isFinalizing) {
      return;
    }

    const now = performance.now();
    const elapsed = now - startTime;

    if (!loadSignaled) {
      const rampRatio = clamp01(elapsed / SOFT_COMPLETE_MS);
      const acceleratedRamp = Math.pow(rampRatio, 1.15);
      const ramp = Math.min(90, acceleratedRamp * 90);
      setPercent(ramp);
    } else {
      const postLoadDuration = Math.max(120, finalizeAt - loadSignaledAt);
      const postLoadRatio = clamp01((now - loadSignaledAt) / postLoadDuration);
      const acceleratedPostLoad = Math.pow(postLoadRatio, 1.2);
      const postLoadRamp =
        postLoadStartPercent + (98 - postLoadStartPercent) * acceleratedPostLoad;
      setPercent(postLoadRamp);
    }

    progressRafId = window.requestAnimationFrame(tick);
  };

  if (document.readyState === "complete") {
    finalizeWhenAllowed();
  } else {
    window.addEventListener("load", finalizeWhenAllowed, { once: true });
  }

  setPercent(0);
  progressRafId = window.requestAnimationFrame(tick);

  softTimerId = window.setTimeout(finalizeWhenAllowed, SOFT_COMPLETE_MS);
  hardTimerId = window.setTimeout(finalize, HARD_COMPLETE_MS);
}

setupScrollReveal();
setupScrollColorTransition();
setupActiveNavSection();
runLoader();
