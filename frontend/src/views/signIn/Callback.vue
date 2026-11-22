<script setup lang="ts">
import {onMounted} from "vue";
import {useRouter} from "vue-router";
import {signIn} from "@/api/users.ts";

const router = useRouter();

onMounted(async () => {
  const savedState = sessionStorage.getItem('oidc_state');
  const params = new URLSearchParams(window.location.search)
  const state = params.get("state");
  const code = params.get("code");
  const next = params.get("next") ?? "/me";

  if (!code || savedState !== state) return router.push("/sign-in");

  if (await signIn(code)) return window.location.href = next;

  return router.push("/sign-in");
});
</script>

<template>

</template>

<style scoped>

</style>