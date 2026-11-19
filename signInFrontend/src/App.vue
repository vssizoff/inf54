<script setup lang="ts">
import {onMounted, ref} from "vue";
import TermWindow from "@/TermWindow.vue";
import TermInput from "@/TermInput.vue";
import TermButton from "@/TermButton.vue";
import TermBG from "@/TermBG.vue";
import ProgressIndicator from "@/progressIndicator.vue";

const username = ref("");
const password = ref("");
const wrong = ref(false);
const pending = ref(false);

function submit() {

}
</script>

<template>
  <header>
    <nav>
      <span class="bracket bracket-left"/>

      <span>
          <span>
            <img src="/inf54.ico" alt=""/>
            <span>
              inf54
            </span>
          </span>
          <span>Вход</span>
        </span>

      <span class="bracket bracket-right"/>
    </nav>
  </header>
  <main>
    <TermWindow class="form" prompt="root@inf54:~# ./login.sh">
      <template #header>
        Добро пожаловать. Вход
      </template>

      <TermInput label="root@inf54:~# username:" mLabel="> username:" placeholder="Имя пользователя" noBreak v-model="username"/>
      <TermInput label="root@inf54:~# password:" mLabel="> password:" placeholder="Пароль" password noBreak v-model="password"/>
      <p class="error" v-if="wrong">Неверное имя пользователя или пароль</p>
      <TermButton @click="submit" :disabled="pending">Войти</TermButton>
      <p>Нет аккаунта? <a class="highlight" href="https://inf54.ru/registration">Регистрация</a></p>
      <p><a class="highlight" href="https://inf54.ru/recovery">Забыли пароль?</a></p>
    </TermWindow>
    <ProgressIndicator v-if="pending"/>
    <TermBG/>
  </main>
</template>

<style scoped>
.error {
  color: red;
}

p {
  margin: 0;
}

:global(.dark) {
  .highlight {
    color: #95EAA7FF;
    text-shadow: 0 0 5px #95EAA7FF;
  }
}

.form {
  width: calc(min(600px, 98vw));
}

main {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 12px;
}

header {
  width: 100%;
  display: flex;
  justify-content: center;
  top: 10px;
  position: sticky;
}

nav {
  display: flex;
  height: 40px;
  width: 729px;
  justify-content: center;
  align-items: center;
  padding: 4px;
  border-radius: 5px;
  list-style: none;
  border: 1px solid #95EAA730;
  background: rgba(96, 151, 109, 0.1);
  backdrop-filter: blur(22px) saturate(180%);
  margin: 0;
  transition: background-color .6s, color .6s;

  & > span:not(.bracket) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0 20px;

    & > span {
      display: flex;
      align-items: center;
      gap: 5px;
    }
  }
}

.bracket {
  border: 2px solid #95EAA7FF;
}

.bracket-left {
  border-right: none;
}

.bracket-right {
  border-left: none;
}

.bracket {
  width: 5px;
  height: 40px;
  opacity: 0.6;
  position: absolute;
  transition: all ease-in-out 0.2s;
}

.bracket-left {
  border-right: none;
  left: 0;
}

.bracket-right {
  border-left: none;
  right: 0;
}

.bracket {
  height: 60px;
}

.bracket-left {
  left: -8px;
  border-top-left-radius: 3px;
  border-bottom-left-radius: 3px;
}

.bracket-right {
  right: -8px;
  border-top-right-radius: 3px;
  border-bottom-right-radius: 3px;
}

img {
  width: 24px;
  height: 24px;
}
</style>

<style>
body {
  background: #121212;
}

* {
  color: white;
  font-family: "PT Mono", monospace;
}

@font-face {
  font-family: 'ShoptronicSP';
  src: url('/ShoptronicSP Basic.otf');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'PT Mono';
  src: url('/PTM55FT.ttf');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
</style>