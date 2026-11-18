<script lang="ts" setup>
import {computed, onMounted, ref, watch} from 'vue'
import {getMe, me, patchUser as patchUser_, patchUserPassword} from "@/api/users.js";
import Title from "@/components/Title.vue";
import TermButton from "@/components/termui/TermButton.vue";
import TermWindow from "@/components/termui/TermWindow.vue";
import TermInput from "@/components/termui/TermInput.vue";
import TermSelect from "@/components/termui/TermSelect.vue";
import {useRouter} from "vue-router";
import {
    ATTRIBUTE_FIELDS,
    attributesFromResponse,
    attributesToPayload,
    emptyAttributes,
    validateAttributes,
    type AttributeErrors,
    type AttributeValues
} from "@/api/attributes.js";

const router = useRouter();

const firstName = ref("");
const lastName = ref("");
const codeforcesHandle = ref("");
const oldPassword = ref("");
const newPassword = ref("");
const newPasswordRepeat = ref("");
const pending = ref(false);
/** Кастомные поля профиля (школа, класс, учитель, город). */
const attributes = ref<AttributeValues>(emptyAttributes());
const attributeErrors = ref<AttributeErrors>({});
/** Сообщение о результате: успех или почему правка не дошла до authentik. */
const patchMessage = ref("");
const passwordMessage = ref("");

const user = computed(() => me.value);

const passwordStrength = computed(() => {
  if (newPassword.value.split("").map(char => char >= 'а' && char <= 'я' || char >= 'А' && char <= 'Я').filter(value => value).length) return -1;
  if (newPassword.value.length < 4) return 0;
  let numbersCount = newPassword.value.split("").map(char => char >= '1' && char <= '9').filter(value => value).length;
  let lowerCaseCount = newPassword.value.split("").map(char => char >= 'a' && char <= 'z').filter(value => value).length;
  let upperCaseCount = newPassword.value.split("").map(char => char >= 'A' && char <= 'Z').filter(value => value).length;
  let symbolsCount = newPassword.value.split("").map(char => !(char >= '1' && char <= '9' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z')).filter(value => value).length;
  return Math.min(numbersCount, 2) + Math.min(lowerCaseCount, 1) + Math.min(upperCaseCount, 1) + Math.min(symbolsCount, 2);
})

async function patchUser(event: Event) {
  event.preventDefault();
  pending.value = true;
  patchMessage.value = "";
  attributeErrors.value = validateAttributes(attributes.value);
  if (Object.keys(attributeErrors.value).length) {
    pending.value = false;
    return;
  }
  let response = await patchUser_({
    firstName: firstName.value,
    lastName: lastName.value,
    codeforcesHandle: codeforcesHandle.value,
    attributes: attributesToPayload(attributes.value)
  });
  pending.value = false;
  if (response === "ok") {
    me.value = await getMe();
    await router.push("/me");
    return;
  }
  if (response === "invalid") {
    patchMessage.value = "Проверьте заполнение полей профиля";
    return;
  }
  if (response === "unavailable") {
    // Правка лежит в нашей базе, но не синхронизирована с authentik: под новым
    // username войти пока нельзя. Об этом надо сказать прямо, а не делать вид,
    // что всё сохранилось.
    patchMessage.value = "Профиль сохранён, но сервис аутентификации его не принял. Повторите позже — пока изменения не синхронизированы, вход идёт по прежнему имени пользователя.";
    return;
  }
  patchMessage.value = "Не удалось сохранить профиль, попробуйте позже";
}

async function patchPassword(event: Event) {
  event.preventDefault();
  pending.value = true;
  passwordMessage.value = "";
  let response = await patchUserPassword(oldPassword.value, newPassword.value);
  pending.value = false;
  if (response === "ok") {
    oldPassword.value = "";
    newPassword.value = "";
    newPasswordRepeat.value = "";
    await router.push("/me");
    return;
  }
  if (response === "wrong") {
    passwordMessage.value = "Старый пароль не подошёл";
    return;
  }
  if (response === "unavailable") {
    passwordMessage.value = "Сервис аутентификации временно недоступен: смена пароля будет доступна чуть позже";
    return;
  }
  passwordMessage.value = "Не удалось сменить пароль, попробуйте позже";
}

function setup() {
  if (user.value) {
    firstName.value = user.value.firstName;
    lastName.value = user.value.lastName;
    codeforcesHandle.value = user.value.codeforcesHandle;
    attributes.value = attributesFromResponse(user.value.attributes);
  }
}

watch(user, () => setup());
// Сообщение об ошибке смены пароля теряет смысл, как только пользователь начал
// вводить старый пароль заново.
watch(oldPassword, () => {
  passwordMessage.value = "";
});

onMounted(() => setup());
</script>

<template>
  <main>
    <template v-if="user">
      <Title text="Настройки"/>
      <div>
        <TermWindow class="form" prompt="root@inf54:~# ./patch-user.sh">
          <template #header>
            Общая информация
          </template>

          <TermInput label="root@inf54:~# name:" mLabel="> name:" placeholder="Имя" noBreak v-model="firstName"/>
          <TermInput label="root@inf54:~# surname:" mLabel="> surname:" placeholder="Фамилия" noBreak v-model="lastName"/>
          <p class="subtitle">Дополнительная информация</p>
          <TermInput label="root@inf54:~# codeforces:" mLabel="> codeforces:" placeholder="Ник на Codeforces" optional noBreak v-model="codeforcesHandle"/>
          <template v-for="field in ATTRIBUTE_FIELDS" :key="field.key">
            <TermSelect
              v-if="field.kind === 'select'"
              :label="`root@inf54:~# ${field.key}:`"
              :mLabel="`> ${field.key}:`"
              :placeholder="field.placeholder"
              :optional="!field.required"
              :options="field.choices ?? []"
              v-model="attributes[field.key]"/>
            <TermInput
              v-else
              :label="`root@inf54:~# ${field.key}:`"
              :mLabel="`> ${field.key}:`"
              :placeholder="field.placeholder"
              :optional="!field.required"
              :min="field.min"
              :max="field.max"
              :pattern="field.pattern"
              :int="field.kind === 'number'"
              noBreak
              v-model="attributes[field.key]"/>
            <p class="error" v-if="attributeErrors[field.key]">{{ attributeErrors[field.key] }}</p>
          </template>
          <p class="error" v-if="patchMessage">{{ patchMessage }}</p>
          <TermButton @click="patchUser" :disabled="pending || firstName.length <= 1 || lastName.length <= 1">Обновить</TermButton>
        </TermWindow>
        <TermWindow class="form" prompt="root@inf54:~# ./patch-user.sh --password">
          <template #header>
            Смена пароля
          </template>

          <TermInput label="root@inf54:~# password:" mLabel="> password:" placeholder="Старый пароль" password noBreak v-model="oldPassword"/>
          <TermInput label="root@inf54:~# newPassword:" mLabel="> newPassword:" placeholder="Новый пароль" password noBreak v-model="newPassword"/>
          <p class="error" v-if="passwordStrength === -1">Не может содержать русские буквы</p>
          <p>Сила пароля: {{passwordStrength}}/6</p>
          <TermInput label="root@inf54:~# confirm:" mLabel="> confirm:" placeholder="Повторите новый пароль" password noBreak v-model="newPasswordRepeat"/>
          <p class="error" v-if="newPassword !== newPasswordRepeat">Не совпадает</p>
          <p class="error" v-if="passwordMessage">{{ passwordMessage }}</p>
          <p class="hint">Пароль хранится в сервисе аутентификации: если он недоступен, смена временно заблокирована — так зеркала не разойдутся.</p>
          <TermButton @click="patchPassword" :disabled="newPassword !== newPasswordRepeat || passwordStrength <= 0 || oldPassword.length <= 0 || pending">Обновить пароль</TermButton>
        </TermWindow>
      </div>
    </template>
  </main>
</template>

<style scoped>
div {
  display: flex;
  justify-content: space-evenly;
  flex-wrap: wrap;
  gap: 10px;
  align-items: baseline;
}
button {
  width: 100%;
}

.form {
  width: calc(min(600px, 98vw));
}

.error {
  color: red;
}

.hint {
  opacity: 0.7;
  font-size: 14px;
}
</style>