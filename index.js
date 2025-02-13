const fs = require('fs');
const path = require('path');
const fields = require('./lib/fields');

module.exports = {
  extend: '@apostrophecms/piece-type',
  options: {
    label: 'aposForm:form',
    pluralLabel: 'aposForm:forms',
    quickCreate: true,
    seoFields: false,
    openGraph: false,
    i18n: {
      ns: 'aposForm',
      browser: true
    }
  },
  bundle: {
    directory: 'modules',
    modules: getBundleModuleNames()
  },
  fields (self) {
    let add = fields.initial(self.options);

    if (self.options.emailSubmissions !== false) {
      add = {
        ...add,
        ...fields.emailFields
      };
    }

    const group = {
      basics: {
        label: 'aposForm:groupForm',
        fields: [ 'contents' ]
      },
      afterSubmit: {
        label: 'aposForm:groupAfterSubmission',
        fields: [
          'thankYouHeading',
          'thankYouBody',
          'sendConfirmationEmail',
          'emailConfirmationField'
        ].concat(self.options.emailSubmissions !== false ? [
          'emails',
          'email'
        ] : [])
      },
      advanced: {
        label: 'aposForm:groupAdvanced',
        fields: [
          'submitLabel',
          'enableRecaptcha',
          'enableQueryParams',
          'queryParamList'
        ]
      }
    };

    return {
      add,
      group
    };
  },
  init (self) {
    self.ensureCollection();

    self.cleanOptions(self.options);
  },
  methods (self) {
    return {
      ...require('./lib/recaptcha')(self),
      async ensureCollection () {
        self.db = self.apos.db.collection('aposFormSubmissions');
        await self.db.ensureIndex({
          formId: 1,
          createdAt: 1
        });
        await self.db.ensureIndex({
          formId: 1,
          createdAt: -1
        });
      },
      processQueryParams (form, input, output, fieldNames) {
        if (!input.queryParams ||
          (typeof input.queryParams !== 'object')) {
          output.queryParams = null;
          return;
        }

        if (Array.isArray(form.queryParamList) && form.queryParamList.length > 0) {
          form.queryParamList.forEach(param => {
            // Skip if this is an existing field submitted by the form. This value
            // capture will be done by populating the form inputs client-side.
            if (fieldNames.includes(param.key)) {
              return;
            }
            const value = input.queryParams[param.key];

            if (value) {
              output[param.key] = self.tidyParamValue(param, value);
            } else {
              output[param.key] = null;
            }
          });
        }
      },
      tidyParamValue(param, value) {
        value = self.apos.launder.string(value);

        if (param.lengthLimit && param.lengthLimit > 0) {
          value = value.substring(0, (param.lengthLimit));
        }

        return value;
      },
      async sendEmailSubmissions (req, form, data) {
        if (self.options.emailSubmissions === false ||
          !form.emails || form.emails.length === 0) {
          return;
        }

        let emails = [];

        form.emails.forEach(mailRule => {
          if (!mailRule.conditions || mailRule.conditions.length === 0) {
            emails.push(mailRule.email);
            return;
          }

          let passed = true;

          mailRule.conditions.forEach(condition => {
            if (!condition.value) {
              return;
            }

            let answer = data[condition.field];

            if (!answer) {
              passed = false;
            } else {
              // Regex for comma-separation from https://stackoverflow.com/questions/11456850/split-a-string-by-commas-but-ignore-commas-within-double-quotes-using-javascript/11457952#comment56094979_11457952
              const regex = /(".*?"|[^",]+)(?=\s*,|\s*$)/g;
              let acceptable = condition.value.match(regex);

              acceptable = acceptable.map(value => {
                // Remove leading/trailing white space and bounding double-quotes.
                value = value.trim();

                if (value[0] === '"' && value[value.length - 1] === '"') {
                  value = value.slice(1, -1);
                }

                return value.trim();
              });

              // If the value is stored as a string, convert to an array for checking.
              if (!Array.isArray(answer)) {
                answer = [ answer ];
              }

              if (!(answer.some(val => acceptable.includes(val)))) {
                passed = false;
              }
            }
          });

          if (passed === true) {
            emails.push(mailRule.email);
          }
        });
        // Get array of email addresses without duplicates.
        emails = [ ...new Set(emails) ];

        if (self.options.testing) {
          return emails;
        }

        if (emails.length === 0) {
          return null;
        }

        for (const key in data) {
          // Add some space to array lists.
          if (Array.isArray(data[key])) {
            data[key] = data[key].join(', ');
          }
        }

        try {
          const emailOptions = {
            form,
            data,
            to: emails.join(',')
          };

          await self.sendEmail(req, 'emailSubmission', emailOptions);

          return null;
        } catch (err) {
          self.apos.util.error('⚠️ @apostrophecms/form submission email notification error: ', err);

          return null;
        }
      },
      // Should be handled async. Options are: form, data, from, to and subject
      async sendEmail (req, emailTemplate, options) {
        const form = options.form;
        const data = options.data;
        return self.email(
          req,
          emailTemplate,
          {
            form: form,
            input: data
          },
          {
            from: options.from || form.email,
            to: options.to,
            subject: options.subject || form.title
          }
        );
      }
    };
  },
  helpers (self) {
    return {
      prependIfPrefix(str) {
        if (self.options.classPrefix) {
          return `${self.options.classPrefix}${str}`;
        }

        return '';
      }
    };
  },
  apiRoutes (self) {
    return {
      post: {
        // Route to accept the submitted form.
        submit: async function (req) {
          const input = req.body;
          const output = {};
          const formErrors = [];
          const formId = self.inferIdLocaleAndMode(req, req.body._id);

          const form = await self.find(req, {
            _id: self.apos.launder.id(formId)
          }).toObject();

          if (!form) {
            throw self.apos.error('notfound');
          }

          if (form.enableRecaptcha) {
            try {
              // Process reCAPTCHA input if needed.
              await self.checkRecaptcha(req, input, formErrors);
            } catch (e) {
              console.error('reCAPTCHA submission error', e);
              throw self.apos.error('invalid');
            }
          }

          // Recursively walk the area and its sub-areas so we find
          // fields nested in two-column widgets and the like

          // walk is not an async function so build an array of them to start
          const areas = [];

          self.apos.area.walk({
            contents: form.contents
          }, function(area) {
            areas.push(area);
          });

          const fieldNames = [];
          const conditionals = {};
          const skipFields = [];

          // Populate the conditionals object fully to clear disabled values
          // before starting sanitization.
          for (const area of areas) {
            const widgets = area.items || [];
            for (const widget of widgets) {
              // Capture field names for the params check list.
              fieldNames.push(widget.fieldName);

              if (widget.type === '@apostrophecms/form-conditional') {
                trackConditionals(conditionals, widget);
              }
            }
          }

          collectToSkip(input, conditionals, skipFields);

          for (const area of areas) {
            const widgets = area.items || [];
            for (const widget of widgets) {
              const manager = self.apos.area.getWidgetManager(widget.type);
              if (
                manager && manager.sanitizeFormField &&
                !skipFields.includes(widget.fieldName)
              ) {
                try {
                  manager.checkRequired(req, widget, input);
                  await manager.sanitizeFormField(widget, input, output);
                } catch (err) {
                  if (err.data && err.data.fieldError) {
                    formErrors.push(err.data.fieldError);
                  } else {
                    throw err;
                  }
                }
              }
            }
          }

          if (formErrors.length > 0) {
            throw self.apos.error('invalid', {
              formErrors
            });
          }

          if (form.enableQueryParams && form.queryParamList.length > 0) {
            self.processQueryParams(form, input, output, fieldNames);
          }

          await self.emit('submission', req, form, output);

          return {};
        }
      }
    };
  },
  handlers (self) {
    return {
      submission: {
        async saveSubmission (req, form, data) {
          if (self.options.saveSubmissions === false) {
            return;
          }
          return self.db.insert({
            createdAt: new Date(),
            formId: form._id,
            data: data
          });
        },
        async emailSubmission (req, form, data) {
          await self.sendEmailSubmissions(req, form, data);
        },
        async emailConfirmation (req, form, data) {
          if (form.sendConfirmationEmail !== true || !form.emailConfirmationField) {
            return;
          }

          // Email validation (Regex reference: https://stackoverflow.com/questions/46155/how-to-validate-an-email-address-in-javascript)
          const re = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

          if (
            data[form.emailConfirmationField] &&
            (typeof data[form.emailConfirmationField] !== 'string' ||
            !re.test(data[form.emailConfirmationField]))
          ) {
            await self.apos.notify(req, 'aposForm:errorEmailConfirm', {
              type: 'warning',
              icon: 'alert-circle-icon',
              interpolate: {
                field: form.emailConfirmationField
              }
            });
            return null;
          }

          try {
            const emailOptions = {
              form,
              data,
              to: data[form.emailConfirmationField]
            };
            await self.sendEmail(req, 'emailConfirmation', emailOptions);

            return null;
          } catch (err) {
            self.apos.util.error('⚠️ @apostrophecms/form submission email confirmation error: ', err);

            return null;
          }
        }
      }
    };
  }
};

function getBundleModuleNames() {
  const source = path.join(__dirname, './modules/@apostrophecms');
  return fs
    .readdirSync(source, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => `@apostrophecms/${dirent.name}`);
}

function trackConditionals(conditionals = {}, widget) {
  const conditionName = widget.conditionName;
  const conditionValue = widget.conditionValue;

  if (!widget || !widget.contents || !widget.contents.items) {
    return;
  }

  conditionals[conditionName] = conditionals[conditionName] || {};

  conditionals[conditionName][conditionValue] = conditionals[conditionName][conditionValue] || [];

  widget.contents.items.forEach(item => {
    conditionals[conditionName][conditionValue].push(item.fieldName);
  });

  // If there aren't any fields in the conditional group, don't bother
  // tracking it.
  if (conditionals[conditionName][conditionValue].length === 0) {
    delete conditionals[conditionName][conditionValue];
  }
}

function collectToSkip(input, conditionals, skipFields) {
  // Check each field that controls a conditional group.
  for (const name in conditionals) {
    // For each value that a conditional group is looking for, check if the
    // value matches in the output and, if not, remove the output properties
    // for the conditional fields.
    for (let value in conditionals[name]) {
      // Booleans are tracked as true/false, but their field values are 'on'. TEMP?
      if (input[name] === true && value === 'on') {
        value = true;
      }
      if (input[name] !== value) {
        conditionals[name][value].forEach(field => {
          skipFields.push(field);
        });
      }
    }
  }
}
