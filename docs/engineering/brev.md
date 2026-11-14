# NVIDIA coach на собственном GPU в Brev

Этот вариант запускает `nvidia/NVIDIA-Nemotron-Nano-9B-v2` из открытых весов NVIDIA. Это **self-hosted inference в Brev**, а не hosted NVIDIA API Catalog. Ключ API Catalog и его SMS-верификация здесь не используются. Проверка настоящего GPU-ответа всё равно обязательна: наличие контейнеров и mock-тесты её не заменяют.

## Схема

Серверный `/api/coach` IncidentLab вызывает HTTPS endpoint. Временный Cloudflare Quick Tunnel передаёт запрос локальному gateway на Brev. Gateway проверяет Bearer token и передаёт только разрешённый chat-запрос vLLM на loopback.

- vLLM: `127.0.0.1:8000`, наружу не открывать.
- Gateway: `127.0.0.1:9000`, токен обязателен для inference.
- Разрешён только `POST /v1/chat/completions`; `/invocations`, `/docs`, `/v1/models` и другие маршруты закрыты.
- `GET /health` показывает только работоспособность gateway, **не** готовность модели.
- Один inference одновременно, 20 принятых запросов в минуту, до 64 KiB на запрос и ответ, 800 output tokens. Логи gateway не содержат запросов и заголовков.

## Перед запуском

Выбрать один уже имеющийся Linux GPU-инстанс. L40S с 48 GB — исходный кандидат, но фактические память, драйвер, диск и цена должны быть проверены в Brev. Запуск расходует кредиты. Не создавать дополнительные инстансы, не добавлять карту и не включать пополнение автоматически.

Нужны Docker Engine с NVIDIA Container Toolkit, Docker Compose >=2.30, Python 3 и минимум 50 GiB свободного места на файловой системе Docker/model cache. Скрипт preflight не устанавливает и не обновляет драйверы. Если у Docker отдельный data-root, свободное место проверить и там.

В VM получить **проверенную опубликованную ветку/commit** репозитория и перейти в её корень. Не использовать `main`, пока приложение туда не объединено. Затем:

```bash
bash infra/brev/preflight.sh
```

При отсутствии `infra/brev/.env` скрипт создаст файл с правами `0600`. Если Brev Launchable уже передал `COACH_GATEWAY_TOKEN` через секретную переменную окружения, значение будет перенесено в файл без вывода. Иначе создаётся пустой шаблон. Пользователь заполняет `COACH_GATEWAY_TOKEN` приватным случайным значением из 32–128 латинских букв, цифр, `_` или `-`. Это собственный токен gateway, не ключ Brev. Секрет не передавать в чат, аргументы команд или Git; содержимое env не выводить. Не запускать полный `docker compose config`: его вывод может включить env. Для проверки схемы использовать только `docker compose config --quiet`, который не печатает развёрнутую конфигурацию.

## Запуск

```bash
(cd infra/brev && docker compose config --quiet)
bash infra/brev/start.sh
```

Подтверждённая причина первого failed setup на `incidentlab-coach`: установленный Docker Compose 2.32.4 отверг сокращение `gpus: all` с ошибкой `services.inference.gpus must be a list`. Preflight до этой ошибки прошёл. В конфигурации теперь используется документированное Docker резервирование ровно одного NVIDIA GPU через `deploy.resources.reservations.devices` с `driver: nvidia`, `count: 1`, `capabilities: [gpu]`. Это изменение схемы запуска не меняет модель, лимиты памяти, gateway или аутентификацию.

Compose запускает vLLM и gateway с `restart: unless-stopped`. Образы закреплены digest, модель и remote code — одним HF revision. NVIDIA сама документирует `vllm-openai:v0.10.1` для этой модели. Используются `float32` для Mamba cache, контекст 8192 и две последовательности; большой дефолтный контекст здесь не нужен. Первая загрузка весов и компиляция могут занять несколько минут; время и производительность не гарантированы.

В фактическом запуске vLLM 0.10.1 автоматически выбрал V0 engine для экспериментальной Mamba-модели. Guided decoding V0 в этой версии удалён ([vLLM PR #21347](https://github.com/vllm-project/vllm/pull/21347)): `response_format: json_schema` не ограничивал генерацию, и реальные ответы содержали Markdown fences либо выдуманные evidence IDs. Строгая проверка честно возвращала rules fallback; удаления fences и нормализации ответа нет.

Точечное исправление в том же закреплённом образе: явно заданы `VLLM_USE_V1=1`, `VLLM_ATTENTION_BACKEND=FLASHINFER` и `--no-enable-prefix-caching`. [Руководство vLLM 0.10.1](https://docs.vllm.ai/en/v0.10.1/usage/v1_guide.html#mamba-models) прямо включает `NemotronHForCausalLM` в поддерживаемые гибридные модели с этими двумя условиями. [Исходник выбора движка](https://github.com/vllm-project/vllm/blob/v0.10.1/vllm/engine/arg_utils.py) разрешает экспериментальный Mamba-путь только при явном `VLLM_USE_V1=1`; без него происходит fallback в V0. Модель, веса, revisions, объём памяти и авторизация не меняются. В реальном запуске V1 загрузил модель и после прогрева вернул корректный JSON probe. Финальный полный `npm run smoke` получил `source: nvidia` и exit 0 за 7,099 с: схема и evidence IDs прошли проверку. Однако **смысловая точность coach не подтверждена**: после нескольких узких prompt-исправлений последний неизменённый ответ всё ещё утверждает рост failures при их снижении, выдумывает допущение о замедлении после recovery. Предложенный retry-backoff 0 разрешён metadata сценария и не является ошибкой. Дальнейшие запросы прекращены. Это доказательство живого inference, а не готового grounded debrief; валидация не ослаблялась, ответ не переписывался. Полный актуальный результат и оригинальный ответ — в [инженерном отчёте](report-ru.md).

Холодный старт и первый запрос со схемой могут включать JIT/компиляцию и выйти за 18-секундный deadline приложения или 20-секундный gateway deadline. В проверке первый timeout оказался временным холодным путём; после прогрева тот же полный запрос прошёл. HTTP health сам по себе не подтверждает готовность к inference. Проверять прямой probe последовательно, дождаться его завершения и затем выполнять один полный smoke; не запускать бесконечные retries и не увеличивать deadline ради холодного запроса.

Для Brev каждый запрос получает JSON schema с `enum` только из фактически переданных evidence IDs. Эта же схема включена в prompt и `response_format`. Затем ответ всё равно строго проверяется `JSON.parse`, исходной Zod-схемой и принадлежностью IDs переданному подмножеству. Это усиление ограничений, а не заранее написанный ответ модели. Fenced JSON, неизвестные IDs и выход за лимиты отвергаются с rules fallback.

Проверка процессов и диагностика модели:

```bash
cd infra/brev
docker compose ps
docker compose logs --tail 60 inference
python3 smoke_gateway.py
```

`smoke_gateway.py` использует секрет из окружения либо соседнего `.env`, не выводит его и требует настоящий структурированный ответ `{ "ok": true }`. Эта проверка подтверждает прямой inference, а не качество coach. При CUDA/driver/OOM ошибке сначала исправить совместимость/память; не открывать GPU API наружу ради диагностики.

После успешного локального inference включить временный HTTPS:

```bash
docker compose --profile demo-tunnel up -d tunnel
docker compose logs --tail 30 tunnel
```

В логах tunnel найти публичный `https://….trycloudflare.com`. Только эта служба не получает gateway token, поэтому её логи не содержат этот секрет. Проверить тот же endpoint с внешнего сервера. Для прямой проверки `smoke_gateway.py` принимает `BREV_GATEWAY_URL` как HTTPS origin без `/v1`, сохраняя credential из env.

Quick Tunnel предназначен для временного демо: адрес изменится при перезапуске, гарантий доступности нет. Non-streaming coach совместим с отсутствием SSE. Публичный сайт на Vercel зависит от работающих Brev VM, модели, gateway и tunnel. Для постоянного production нужен стабильный HTTPS endpoint.

## Настройки IncidentLab

В **серверном** окружении локального Next.js и Vercel задать:

```dotenv
NVIDIA_DEPLOYMENT=brev
NVIDIA_BASE_URL=https://PUBLIC-TUNNEL-HOST/v1
NVIDIA_MODEL=nvidia/NVIDIA-Nemotron-Nano-9B-v2
NVIDIA_API_KEY=THE_SAME_PRIVATE_GATEWAY_TOKEN
```

Существующий env-файл не перезаписывать. Здесь `NVIDIA_API_KEY` содержит собственный gateway token; он не отправляется в NVIDIA API Catalog. Не ставить эти значения в `NEXT_PUBLIC_*`. После изменения env перезапустить dev-сервер или создать новый Vercel deployment.

```bash
npm run smoke
```

Успех требует настоящего ответа модели, схемы coach и существующих evidence IDs; rules fallback проверку не проходит. Поле `source: nvidia` сопровождается явным ограничением `Self-hosted NVIDIA model on Brev`. Это не утверждение об использовании hosted NVIDIA API. Реальную задержку проверить после прогрева, включая 18-секундный предел backend.

## Подтверждённые проблемы окружения

После исправления схемы Compose следующая фактическая ошибка OCI была `unresolvable CDI devices nvidia.com/gpu=0`. Runtime использовал режим CDI, но `nvidia-ctk cdi list` находил 0 устройств, а каталоги спецификаций `/etc/cdi` и `/var/run/cdi` отсутствовали. Это отдельная проблема передачи GPU в контейнер; доступность GPU в `nvidia-smi` на host её не исключает.

После подтверждения отсутствующей спецификации её можно создать штатным инструментом NVIDIA на host:

```bash
sudo install -d -m 0755 /var/run/cdi
sudo nvidia-ctk cdi generate --feature-flag=disable-nvsandboxutils --output=/var/run/cdi/nvidia.yaml
nvidia-ctk cdi list
```

На фактическом сочетании Toolkit 1.20.1 и драйвера 565.57.01 обычная генерация без флага завершилась SIGABRT: `free(): invalid pointer` в `nvSandboxUtilsShutdown` библиотеки `libnvidia-sandboxutils`. Подтверждённый обход — process-local `--feature-flag=disable-nvsandboxutils`; он отключает только этот способ discovery и оставляет NVML. Флаг проверен по [исходникам Toolkit v1.20.1](https://github.com/NVIDIA/nvidia-container-toolkit/blob/v1.20.1/pkg/nvcdi/api.go). После генерации на этой VM обнаружены 3 CDI-имени одного GPU: индекс 0, UUID и `all`. Драйвер не менялся. Сам `--mode=nvml` не предотвращает загрузку sandboxutils; если он используется явно, необходим также feature flag.

Эти ручные команды не обновляют драйвер и не перезапускают Docker. В startup/preflight автоматические sudo-изменения не добавлены. Согласно [документации NVIDIA CDI](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html), Toolkit начиная с 1.18 предусматривает `nvidia-cdi-refresh`; его состояние и актуальность спецификации нужно повторно проверить после перезапуска VM. `/var/run` является runtime-каталогом, поэтому наличие созданного файла не гарантируется после остановки/старта или reboot. После изменения драйвера либо GPU/MIG-конфигурации также нужна повторная проверка.

В этом же запуске локальный Brev CLI сгенерировал host SSH port 18022, тогда как актуальный `GetEnvironment` сообщал port 22. Для диагностики использован временный конфиг SSH только для этой задачи с параметрами из актуальных SSH access metadata. Глобальный SSH-конфиг не переписывался, проверка host key не отключалась. При следующем старте заново получить актуальные host/port и сверить host key; старый task-local override не считать постоянной конфигурацией.

## Остановка

Из корня репозитория:

```bash
bash infra/brev/stop.sh
```

Это останавливает контейнеры, сохраняя cache. **Затем остановить сам инстанс в Brev** и проверить его итоговый статус: остановка контейнеров не прекращает аренду GPU. Кэш/тома и прежние инстансы автоматически не удаляются.

В проверке 14 ноября 2026 контейнеры и `brev stop` завершились exit 0; актуальный `GetEnvironment` подтвердил **STOPPED** для существующей машины `incidentlab-coach`, ID `vklyxhkb4`. Остаток кредитов $9,33 → $7,92: списание $1,41 на момент проверки, без пополнений. По верхней длительности защитного таймера 3058 с и проверенной суммарной ставке расход интервала ≤$1,53 при разрешённом максимуме $3; ledger может запаздывать. GPU не оставлен работать. После остановки живой coach недоступен до нового запуска, rules fallback сохранён.

## Проверки без GPU

```bash
python3 -m unittest discover -s infra/brev -p 'test_gateway.py' -v
python3 -m py_compile infra/brev/gateway.py infra/brev/smoke_gateway.py
bash -n infra/brev/preflight.sh infra/brev/start.sh infra/brev/stop.sh
```

Upstream в этих тестах — явный test double. Они проверяют границу gateway, но не CUDA, загрузку модели, inference, публичный tunnel или Vercel.

## Первичные источники

- [NVIDIA model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2): vLLM, модель, `/no_think`, Mamba cache и официальный пример контейнера.
- [Brev connectivity](https://docs.nvidia.com/brev/cli/connectivity): особенности стандартного Secure Link и SSH forwarding.
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/): временный HTTPS без аккаунта/домена и ограничения.
- [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/stable/serving/online_serving/openai_compatible_server/): API и ограничения встроенной аутентификации.
- [Docker Compose GPU reservations](https://docs.docker.com/compose/how-tos/gpu-support/): переносимое выделение NVIDIA GPU через device reservation.
- [NVIDIA CDI support](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html): генерация и обновление спецификации GPU-устройств.
