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

При отсутствии `infra/brev/.env` скрипт создаст файл с правами `0600`. Если Brev Launchable уже передал `COACH_GATEWAY_TOKEN` через секретную переменную окружения, значение будет перенесено в файл без вывода. Иначе создаётся пустой шаблон. Пользователь заполняет `COACH_GATEWAY_TOKEN` приватным случайным значением из 32–128 латинских букв, цифр, `_` или `-`. Это собственный токен gateway, не ключ Brev. Секрет не передавать в чат, аргументы команд или Git; содержимое env не выводить. Не запускать `docker compose config`: его полный вывод может включить env.

## Запуск

```bash
bash infra/brev/start.sh
```

Compose запускает vLLM и gateway с `restart: unless-stopped`. Образы закреплены digest, модель и remote code — одним HF revision. NVIDIA сама документирует `vllm-openai:v0.10.1` для этой модели. Используются `float32` для Mamba cache, контекст 8192 и две последовательности; большой дефолтный контекст здесь не нужен. Первая загрузка весов и компиляция могут занять несколько минут; время и производительность не гарантированы.

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

## Остановка

Из корня репозитория:

```bash
bash infra/brev/stop.sh
```

Это останавливает контейнеры, сохраняя cache. **Затем остановить сам инстанс в Brev** и проверить его итоговый статус: остановка контейнеров не прекращает аренду GPU. Кэш/тома и прежние инстансы автоматически не удаляются.

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
