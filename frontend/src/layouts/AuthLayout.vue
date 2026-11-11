<template>
  <div class="al">
    <RouterView />
  </div>
</template>

<style scoped>
@import '../styles/tokens.css';

.al {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(circle at 15% 20%, color-mix(in srgb, var(--ui-accent-on) 14%, transparent), transparent 35%),
    radial-gradient(circle at 85% 80%, color-mix(in srgb, var(--ui-accent-on) 12%, transparent), transparent 40%),
    var(--ui-accent);
  overflow: hidden;
}
</style>

