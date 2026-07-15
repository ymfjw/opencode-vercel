package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

//go:embed public/*
var publicFiles embed.FS

// 反向映射：把响应里的 free 名字换回 pro 名字，骗过下游统计工具
var responseReplacer = strings.NewReplacer(
	"mimo-v2.5-free", "mimo-v2.5-pro",
	"deepseek-v4-flash-free", "deepseek-v4-flash",
)

// 流式替换 Reader：对响应体做实时字符串替换（兼容 SSE 流）
type replacingReadCloser struct {
	src     io.ReadCloser
	buf     []byte // 未处理的残留字节
	done    bool
}

func (r *replacingReadCloser) Read(p []byte) (int, error) {
	if r.done && len(r.buf) == 0 {
		return 0, io.EOF
	}

	// 从上游读取新数据
	tmp := make([]byte, len(p))
	n, err := r.src.Read(tmp)
	if err != nil && err != io.EOF {
		return 0, err
	}
	if err == io.EOF {
		r.done = true
	}

	// 拼接残留 + 新数据
	combined := append(r.buf, tmp[:n]...)

	// 保留尾部 30 字节防止替换目标被截断（最长目标 "deepseek-v4-flash-free" = 22 字节）
	overlap := 30
	var toProcess, toKeep []byte
	if r.done || len(combined) <= overlap {
		toProcess = combined
		toKeep = nil
	} else {
		toProcess = combined[:len(combined)-overlap]
		toKeep = combined[len(combined)-overlap:]
	}

	replaced := responseReplacer.Replace(string(toProcess))
	r.buf = toKeep

	copied := copy(p, replaced)
	if copied < len(replaced) {
		// 输出缓冲区不够大，把剩余的存回 buf
		r.buf = append([]byte(replaced[copied:]), r.buf...)
	}

	if r.done && len(r.buf) == 0 {
		return copied, io.EOF
	}
	return copied, nil
}

func (r *replacingReadCloser) Close() error {
	return r.src.Close()
}

func main() {
	subFS, err := fs.Sub(publicFiles, "public")
	if err != nil {
		log.Fatalf("无法加载内嵌的静态文件系统: %v", err)
	}
	fsHandler := http.FileServer(http.FS(subFS))

	targetURL, _ := url.Parse("https://opencode.ai")
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	originalDirector := proxy.Director

	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		if strings.HasPrefix(req.URL.Path, "/v1/") {
			req.URL.Path = "/zen" + req.URL.Path
		}
		req.Host = targetURL.Host
		req.Header.Set("Authorization", "Bearer public")
		req.Header.Set("x-opencode-client", "desktop")

		if req.Method == "POST" && req.Body != nil {
			bodyBytes, err := io.ReadAll(req.Body)
			if err == nil {
				var reqData map[string]interface{}
				if err := json.Unmarshal(bodyBytes, &reqData); err == nil {
					if model, ok := reqData["model"].(string); ok {
						modified := false
						if model == "deepseek-v4-flash" {
							reqData["model"] = "deepseek-v4-flash-free"
							modified = true
						} else if model == "mimo-v2.5-pro" {
							reqData["model"] = "mimo-v2.5-free"
							modified = true
						}
						if modified {
							newBodyBytes, _ := json.Marshal(reqData)
							req.Body = io.NopCloser(bytes.NewBuffer(newBodyBytes))
							req.ContentLength = int64(len(newBodyBytes))
						} else {
							req.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
						}
					} else {
						req.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
					}
				} else {
					req.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
				}
			}
		}
	}

	// 响应拦截：把 free 模型名换回 pro，让下游统计工具看到的永远是 pro
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Body = &replacingReadCloser{src: resp.Body}
		resp.Header.Del("Content-Length") // 替换后长度可能变化
		resp.ContentLength = -1
		return nil
	}

	corsMiddleware := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, x-api-key")

			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			authHeader := r.Header.Get("Authorization")
			apiKey := r.Header.Get("x-api-key")
			if authHeader != "Bearer sk-mimo" && apiKey != "sk-mimo" {
				http.Error(w, "Unauthorized: Invalid API Key", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		}
	}

	modelsHandler := func(w http.ResponseWriter, r *http.Request) {
		resData := map[string]interface{}{
			"object": "list",
			"data": []map[string]interface{}{
				{
					"id":       "deepseek-v4-flash",
					"object":   "model",
					"created":  time.Now().Unix(),
					"owned_by": "mimo",
				},
				{
					"id":       "mimo-v2.5-pro",
					"object":   "model",
					"created":  time.Now().Unix(),
					"owned_by": "mimo",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resData)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", corsMiddleware(modelsHandler))
	mux.HandleFunc("/v1/", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/api", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		urlData, err := os.ReadFile("/tmp/tunnel.url")
		if err != nil {
			w.Write([]byte("Tunnel URL is not ready yet. Please refresh in a few seconds..."))
			return
		}
		w.Write(urlData)
	})
	mux.Handle("/", fsHandler)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("全能单口代理网关启动，内置静态资源，监听端口 :%s...", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("网关启动失败: %v", err)
	}
}
