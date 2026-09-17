(in-package #:quasar.fbp)

(defparameter +credential-reference-prefix+ "credential:")

(defun signal-installer-validation-error (code message)
  (error 'validation-error :code code :message message))

(defun control-character-p (character)
  (let ((code (char-code character)))
    (or (< code 32)
        (<= 127 code 159))))

(defun ascii-alphanumeric-p (character)
  (or (and (char<= #\a character) (char<= character #\z))
      (and (char<= #\A character) (char<= character #\Z))
      (and (char<= #\0 character) (char<= character #\9))))

(defun ensure-clean-string (value field &key (maximum-length 2048))
  (unless (and (stringp value)
               (plusp (length value))
               (<= (length value) maximum-length))
    (signal-installer-validation-error
     "fbp.invalid-installer-value"
     (format nil "~A must be a non-empty string no longer than ~D characters."
             field maximum-length)))
  (when (find-if #'control-character-p value)
    (signal-installer-validation-error
     "fbp.invalid-installer-value"
     (format nil "~A must not contain control characters or newlines." field)))
  value)

(defun string-prefix-equal-p (prefix value)
  (and (<= (length prefix) (length value))
       (string-equal prefix value :end2 (length prefix))))

(defun valid-port-p (value)
  (and (plusp (length value))
       (every (lambda (character)
                (and (char<= #\0 character) (char<= character #\9)))
              value)
       (let ((port (parse-integer value)))
         (<= 1 port 65535))))

(defun valid-host-p (authority)
  (cond
    ((and (plusp (length authority))
          (char= (char authority 0) #\[))
     (let ((close (position #\] authority)))
       (and close
            (> close 1)
            (every (lambda (character)
                     (or (digit-char-p character 16)
                         (member character '(#\: #\.))))
                   (subseq authority 1 close))
            (or (= (1+ close) (length authority))
                (and (char= (char authority (1+ close)) #\:)
                     (valid-port-p (subseq authority (+ close 2))))))))
    (t
     (let* ((colon (position #\: authority :from-end t))
            (host (if colon (subseq authority 0 colon) authority))
            (port (and colon (subseq authority (1+ colon)))))
       (and (plusp (length host))
            (ascii-alphanumeric-p (char host 0))
            (ascii-alphanumeric-p (char host (1- (length host))))
            (every (lambda (character)
                     (or (ascii-alphanumeric-p character)
                         (member character '(#\. #\-))))
                   host)
            (or (null port) (valid-port-p port)))))))

(defun valid-endpoint-path-p (value)
  (every (lambda (character)
           (or (ascii-alphanumeric-p character)
               (member character '(#\/ #\: #\- #\. #\_ #\~ #\%))))
         value))

(defun validate-endpoint (value)
  (let* ((endpoint (ensure-clean-string value "endpoint"))
         (scheme-length
           (cond
             ((string-prefix-equal-p "https://" endpoint) 8)
             ((string-prefix-equal-p "http://" endpoint) 7)
             (t
              (signal-installer-validation-error
               "fbp.invalid-endpoint"
               "Endpoint must use an explicit http:// or https:// URL."))))
         (remainder (subseq endpoint scheme-length))
         (path-start (position #\/ remainder))
         (authority (if path-start (subseq remainder 0 path-start) remainder))
         (path (and path-start (subseq remainder path-start))))
    (unless (and (not (find #\@ authority))
                 (valid-host-p authority)
                 (or (null path) (valid-endpoint-path-p path)))
      (signal-installer-validation-error
       "fbp.invalid-endpoint"
       "Endpoint must be an HTTP(S) base URL without credentials, query, fragment, or unsafe characters."))
    endpoint))

(defun validate-credential-reference (value)
  (let ((reference
          (ensure-clean-string value "credential reference" :maximum-length 256)))
    (unless (and (> (length reference) (length +credential-reference-prefix+))
                 (string-prefix-equal-p +credential-reference-prefix+ reference)
                 (every (lambda (character)
                          (or (ascii-alphanumeric-p character)
                              (member character '(#\_ #\. #\-))))
                        (subseq reference (length +credential-reference-prefix+))))
      (signal-installer-validation-error
       "fbp.invalid-credential-reference"
       "Credential reference must match credential:[A-Za-z0-9_.-]+."))
    reference))

(defun posix-single-quote (value)
  "Quote VALUE as one inert POSIX shell word."
  (ensure-clean-string value "profile value")
  (with-output-to-string (stream)
    (write-char #\' stream)
    (loop for character across value
          do (if (char= character #\')
                 (write-string "'\\''" stream)
                 (write-char character stream)))
    (write-char #\' stream)))

(defun systemd-quote-argument (value)
  "Quote one systemd ExecStart argument without invoking a shell."
  (ensure-clean-string value "systemd argument" :maximum-length 4096)
  (with-output-to-string (stream)
    (write-char #\" stream)
    (loop for character across value
          do (case character
               (#\\ (write-string "\\\\" stream))
               (#\" (write-string "\\\"" stream))
               (#\% (write-string "%%" stream))
               (#\$ (write-string "$$" stream))
               (otherwise (write-char character stream))))
    (write-char #\" stream)))

(defun safe-unit-id (id)
  (let ((value (canonical-name id)))
    (unless (and (plusp (length value))
                 (every (lambda (character)
                          (or (alphanumericp character) (find character "-_.")))
                        value))
      (error 'validation-error :code "fbp.invalid-deployment-id"
             :message "Deployment ids may contain only letters, digits, dash, dot, and underscore."))
    value))

(defun xdg-path (environment-name fallback &rest parts)
  (let ((root (or (uiop:getenv environment-name)
                  (merge-pathnames fallback (user-homedir-pathname)))))
    (reduce #'merge-pathnames parts :initial-value (uiop:ensure-directory-pathname root))))

(defun required-automation-executable (executable)
  (let* ((value (ensure-clean-string executable "automation executable"
                                     :maximum-length 4096))
         (path (pathname value)))
    (when (wild-pathname-p path)
      (signal-installer-validation-error
       "fbp.invalid-automation-executable"
       "Automation executable path must not contain wildcards."))
    (let ((resolved (probe-file path)))
      (unless (and (eq (first (pathname-directory path)) :absolute)
                   resolved
                   (pathname-name resolved))
        (signal-installer-validation-error
         "fbp.invalid-automation-executable"
         "Automation executable must be an explicit, existing absolute file path."))
      (namestring resolved))))

(defun automation-plan (network &key executable graph-path endpoint
                                      (credential-reference
                                        "credential:starintel-api"))
  "Return a write/enable plan. It never includes secret values."
  (let* ((id (safe-unit-id (network-id network)))
         (unit-name (format nil "quasar-fbp@~A.service" id))
         (unit-path (merge-pathnames unit-name
                                     (xdg-path "XDG_CONFIG_HOME" ".config/"
                                               "systemd/" "user/")))
         (source (or graph-path
                     (merge-pathnames (format nil "workflows/~A.lisp" id)
                                      (xdg-path "XDG_CONFIG_HOME" ".config/" "quasar/"))))
         ;; There is no independently packaged `quasar-fbp` executable in this
         ;; system. Callers must select the real packaged Quasar entry point.
         (runner (required-automation-executable executable))
         (validated-endpoint (and endpoint (validate-endpoint endpoint)))
         (validated-reference (and endpoint
                                   (validate-credential-reference
                                    credential-reference)))
         (credential-name (and validated-reference
                               (subseq validated-reference
                                       (length +credential-reference-prefix+))))
         (credential-path
           (and credential-name
                (merge-pathnames credential-name
                                 (xdg-path "XDG_CONFIG_HOME" ".config/"
                                           "quasar/" "credentials/"))))
         (environment-lines
           (if validated-endpoint
               (format nil "Environment=~A~%Environment=~A~%LoadCredential=~A~%"
                       (systemd-quote-argument
                        (format nil "STARINTEL_ENDPOINT=~A" validated-endpoint))
                       (systemd-quote-argument
                        (format nil "STARINTEL_CREDENTIAL_REF=~A"
                                validated-reference))
                       (systemd-quote-argument
                        (format nil "~A:~A" credential-name
                                (namestring credential-path))))
               ""))
         (unit (format nil
                       "[Unit]~%Description=Quasar FBP automation %i~%After=network-online.target~%~%[Service]~%Type=simple~%~AExecStart=~A fbp-run --graph ~A~%NoNewPrivileges=yes~%PrivateTmp=yes~%ProtectSystem=strict~%ProtectHome=read-only~%RestrictSUIDSGID=yes~%LockPersonality=yes~%MemoryDenyWriteExecute=yes~%~%[Install]~%WantedBy=default.target~%"
                       environment-lines
                       (systemd-quote-argument runner)
                       (systemd-quote-argument (namestring source)))))
    (list :id id :unit-name unit-name :unit-path unit-path
          :graph-path source :graph-source (network-to-lisp network)
          :credential-path credential-path
          :unit-source unit
          :enable (and (network-enabled-at-login-p network) t)
          :commands (append (list (list "systemctl" "--user" "daemon-reload"))
                            (when (network-enabled-at-login-p network)
                              (list (list "systemctl" "--user" "enable" "--now" unit-name)))))))

(defun temporary-sibling-path (path)
  (make-pathname
   :name (format nil ".~A.~36R.~36R"
                 (or (pathname-name path) "quasar")
                 (get-universal-time)
                 (random most-positive-fixnum))
   :type "tmp"
   :defaults path))

(defun open-exclusive-temporary (path)
  (loop repeat 128
        for temporary = (temporary-sibling-path path)
        for stream = (open temporary
                           :direction :output
                           :if-exists nil
                           :if-does-not-exist :create)
        when stream do (return (values temporary stream))
        finally
           (signal-installer-validation-error
            "fbp.temporary-file-unavailable"
            "Could not create a private temporary file for the installer.")))

(defun set-owner-only-permissions (path)
  "Set mode 0600 when a platform chmod implementation is available."
  (let ((chmod (or (probe-file #P"/bin/chmod")
                   (probe-file #P"/usr/bin/chmod"))))
    (when chmod
      (uiop:run-program
       (list (namestring chmod) "600" (namestring path))
       :output nil
       :error-output nil)))
  path)

(defun atomic-write-text (path content)
  (unless (stringp content)
    (signal-installer-validation-error
     "fbp.invalid-installer-content"
     "Installer content must be a string."))
  (ensure-directories-exist path)
  (multiple-value-bind (temporary stream)
      (open-exclusive-temporary path)
    (unwind-protect
         (progn
           ;; Tighten the mode before any potentially sensitive content is
           ;; written, rather than relying on the caller's umask.
           (set-owner-only-permissions temporary)
           (write-string content stream)
           (finish-output stream)
           (close stream)
           (setf stream nil)
           (uiop:rename-file-overwriting-target temporary path)
           (set-owner-only-permissions path)
           path)
      (when stream
        (ignore-errors (close stream :abort t)))
      (when (probe-file temporary)
        (ignore-errors (delete-file temporary))))))

(defun apply-automation-plan (plan &key (execute-commands nil))
  (atomic-write-text (getf plan :graph-path) (getf plan :graph-source))
  (atomic-write-text (getf plan :unit-path) (getf plan :unit-source))
  (when execute-commands
    (dolist (argv (getf plan :commands))
      (uiop:run-program argv :output *standard-output* :error-output *error-output*)))
  plan)

(defun profile-plan (&key endpoint (credential-reference "credential:starintel-api")
                          (shell :sh))
  "Create an idempotent managed profile block containing references, never keys."
  (unless (member shell '(:sh :bash))
    (error 'validation-error :code "fbp.unsupported-shell"
           :message "Only POSIX sh and bash profiles are supported."))
  (let* ((validated-endpoint
           (validate-endpoint (or endpoint "http://127.0.0.1:5000")))
         (validated-reference
           (validate-credential-reference credential-reference))
         (profile (merge-pathnames (if (eq shell :bash) ".bash_profile" ".profile")
                                   (user-homedir-pathname)))
         (begin "# >>> quasar-fbp >>>")
         (end "# <<< quasar-fbp <<<")
         (block (format nil "~A~%export STARINTEL_ENDPOINT=~A~%export STARINTEL_CREDENTIAL_REF=~A~%~A~%"
                        begin
                        (posix-single-quote validated-endpoint)
                        (posix-single-quote validated-reference)
                        end)))
    (list :path profile :begin begin :end end :content block)))

(defun strip-managed-block (source begin end)
  (let ((start (search begin source))
        (finish (search end source)))
    (cond
      ((and (null start) (null finish)) source)
      ((or (null start)
           (null finish)
           (< finish start)
           (search begin source :start2 (+ start (length begin)))
           (search end source :start2 (+ finish (length end))))
       (signal-installer-validation-error
        "fbp.malformed-profile-markers"
        "Managed profile markers are missing, duplicated, or out of order; refusing to rewrite the profile."))
      (t
       (concatenate 'string
                    (subseq source 0 start)
                    (subseq source (+ finish (length end))))))))

(defun apply-profile-plan (plan)
  (let* ((path (getf plan :path))
         (existing (if (probe-file path) (uiop:read-file-string path) ""))
         (base (string-right-trim '(#\Space #\Tab #\Newline #\Return)
                                  (strip-managed-block existing
                                                       (getf plan :begin)
                                                       (getf plan :end))))
         (updated (format nil "~A~@[~%~]~A" base (plusp (length base))
                          (getf plan :content))))
    (atomic-write-text path updated)
    plan))
